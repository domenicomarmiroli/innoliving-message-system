import type { Db } from '../../db/index.js'
import type { Logger } from '../../logger.js'
import { chiaveThread, type Aggancio } from './aggancia.js'
import { perArchivio } from './parse.js'
import type { EmailGrezza, Riconoscimento } from './tipi.js'

/**
 * Scrittura idempotente di una email in arrivo.
 *
 * La difesa contro i duplicati è il vincolo message_rfc822_key: la stessa
 * email, riprocessata dieci volte, resta un solo messaggio. Questa
 * funzione può essere rieseguita su tutta la casella senza conseguenze,
 * ed è quello che vogliamo il giorno in cui dovremo rifare l'ingestione.
 */

export type EsitoMessaggio = 'inserito' | 'gia_presente'

export interface RisultatoUpsertEmail {
  esito: EsitoMessaggio
  message_id: string | null
  thread_id: string
  nuovo_thread: boolean
}

export async function upsertEmail(
  db: Db,
  log: Logger,
  email: EmailGrezza,
  riconoscimento: Riconoscimento,
  agg: Aggancio,
): Promise<RisultatoUpsertEmail> {
  return db.begin(async (tx) => {
    const arrivata = email.date ?? new Date()

    // --- SLA del canale, per sapere entro quando va risposto -----------
    const [account] = await tx<{ sla_minutes: number }[]>`
      select sla_minutes from channel_account where id = ${riconoscimento.account_id}
    `
    const slaMinuti = account?.sla_minutes ?? 1440
    const scadenza = new Date(arrivata.getTime() + slaMinuti * 60_000)

    // --- Il thread ------------------------------------------------------
    let threadId = agg.thread_id
    let nuovoThread = false

    if (!threadId) {
      const chiave = chiaveThread(riconoscimento, agg.order_id)

      if (chiave) {
        // Il vincolo unique (account_id, external_thread_id) fa il lavoro:
        // due email dello stesso cliente sullo stesso ordine finiscono
        // nella stessa conversazione, non in due.
        const [riga] = await tx<{ id: string; created: boolean }[]>`
          insert into thread (
            account_id, external_thread_id, order_id, subject, state,
            first_inbound_at, last_inbound_at, due_at
          ) values (
            ${riconoscimento.account_id}, ${chiave}, ${agg.order_id},
            ${email.subject}, ${agg.order_id ? 'new' : 'unmatched'},
            ${arrivata}, ${arrivata}, ${scadenza}
          )
          on conflict (account_id, external_thread_id)
            where external_thread_id is not null
          do update set updated_at = now()
          returning id, (xmax = 0) as created
        `
        threadId = riga!.id
        nuovoThread = riga!.created
      } else {
        const [riga] = await tx<{ id: string }[]>`
          insert into thread (
            account_id, order_id, subject, state,
            first_inbound_at, last_inbound_at, due_at
          ) values (
            ${riconoscimento.account_id}, ${agg.order_id}, ${email.subject},
            'unmatched', ${arrivata}, ${arrivata}, ${scadenza}
          )
          returning id
        `
        threadId = riga!.id
        nuovoThread = true
      }
    }

    // --- Il messaggio ---------------------------------------------------
    // Se rfc822_id manca (rarissimo ma possibile) ripieghiamo sull'UID
    // IMAP, che è unico nella cartella: meglio una chiave locale che
    // nessuna chiave.
    const chiaveEsterna = email.rfc822_id ?? (email.uid !== null ? `uid:${email.uid}` : null)

    const [messaggio] = await tx<{ id: string }[]>`
      insert into message (
        thread_id, direction, author_kind, external_id, rfc822_id, in_reply_to,
        body_text, body_html, sent_at, match_strategy, raw
      ) values (
        ${threadId}, 'in', 'customer', ${chiaveEsterna}, ${email.rfc822_id},
        ${email.in_reply_to}, ${email.body_text}, ${email.body_html},
        ${arrivata}, ${agg.strategia}, ${tx.json(perArchivio(email) as never)}
      )
      on conflict (rfc822_id) where rfc822_id is not null
      do nothing
      returning id
    `

    if (!messaggio) {
      // Già vista. Non tocchiamo il thread: rielaborare la casella non
      // deve far risalire conversazioni chiuse in cima alla coda.
      return {
        esito: 'gia_presente' as const,
        message_id: null,
        thread_id: threadId,
        nuovo_thread: false,
      }
    }

    // --- Gli allegati ---------------------------------------------------
    for (const a of email.allegati) {
      await tx`
        insert into attachment (
          message_id, direzione, nome_file, mime, dimensione_byte, checksum
        ) values (
          ${messaggio.id}, 'in', ${a.nome_file}, ${a.mime},
          ${a.dimensione_byte}, ${a.checksum}
        )
      `
    }

    // --- Il thread torna in coda ----------------------------------------
    // Uno stato 'closed' che riceve una nuova email torna aperto: il
    // cliente ha risposto, la pratica non è finita.
    await tx`
      update thread set
        last_inbound_at  = greatest(coalesce(last_inbound_at, ${arrivata}), ${arrivata}),
        first_inbound_at = least(coalesce(first_inbound_at, ${arrivata}), ${arrivata}),
        order_id         = coalesce(${agg.order_id}, order_id),
        subject          = coalesce(subject, ${email.subject}),
        due_at           = ${scadenza},
        state            = case
                             when state = 'unmatched' and ${agg.order_id}::uuid is not null then 'open'
                             when state = 'closed' then 'open'
                             when state = 'pending_customer' then 'open'
                             else state
                           end,
        updated_at       = now()
      where id = ${threadId}
    `

    if (agg.strategia === 'nessuna') {
      log.warn(
        { account: riconoscimento.account_code, thread_id: threadId },
        'email non agganciata a nessun ordine: thread in unmatched',
      )
    }

    return {
      esito: 'inserito' as const,
      message_id: messaggio.id,
      thread_id: threadId,
      nuovo_thread: nuovoThread,
    }
  })
}
