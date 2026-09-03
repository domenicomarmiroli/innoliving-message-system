import type { Config } from '../../config.js'
import type { Db } from '../../db/index.js'
import type { Logger } from '../../logger.js'
import { dimensioniImmagine } from '../../core/immagine.js'
import { caricaAllegato, storageConfigurato } from '../../core/storage.js'
import { chiaveThread, type Aggancio } from './aggancia.js'
import { perArchivio } from './parse.js'
import { ripulisci } from './ripulisci.js'
import type { AllegatoGrezzo, EmailGrezza, OpzioniIngest, Riconoscimento } from './tipi.js'

interface AllegatoPronto extends AllegatoGrezzo {
  storage_path: string | null
  larghezza: number | null
  altezza: number | null
}

/**
 * Carica i byte su Storage PRIMA di aprire la transazione: è I/O di rete,
 * e tenerla dentro una transazione database terrebbe lock aperti per
 * tutta la durata dell'upload. Se lo storage non è configurato, l'email
 * entra comunque — solo senza il file, non senza il messaggio: un
 * allegato mancante è un problema più piccolo di un ticket perso.
 */
async function preparaAllegati(
  config: Config,
  log: Logger,
  accountCode: string,
  allegati: AllegatoGrezzo[],
): Promise<AllegatoPronto[]> {
  if (allegati.length === 0) return []

  if (!storageConfigurato(config)) {
    log.warn('Storage non configurato: allegati registrati solo come metadati')
    return allegati.map((a) => ({ ...a, storage_path: null, larghezza: null, altezza: null }))
  }

  return Promise.all(
    allegati.map(async (a) => {
      const dimensioni = await dimensioniImmagine(a.contenuto)
      let storage_path: string | null = null
      try {
        const percorso = `${accountCode}/${a.checksum}-${a.nome_file ?? 'allegato'}`
        storage_path = await caricaAllegato(config, percorso, a.contenuto, a.mime)
      } catch (errore) {
        log.error(
          { err: errore instanceof Error ? errore.message : String(errore), nome_file: a.nome_file },
          'upload allegato su Storage fallito: registrato solo il metadato',
        )
      }
      return {
        ...a,
        storage_path,
        larghezza: dimensioni?.larghezza ?? null,
        altezza: dimensioni?.altezza ?? null,
      }
    }),
  )
}

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
  config: Config,
  email: EmailGrezza,
  riconoscimento: Riconoscimento,
  agg: Aggancio,
  opzioni: OpzioniIngest,
): Promise<RisultatoUpsertEmail> {
  const allegatiPronti = await preparaAllegati(
    config,
    log,
    riconoscimento.account_code,
    email.allegati,
  )

  return db.begin(async (tx) => {
    const arrivata = email.date ?? new Date()

    // Il corpo che si legge è quello ripulito dall'impalcatura del
    // relay. L'integrale non si perde: resta in `raw`, da cui si
    // riprocessa se un giorno scopriremo che la pulizia tagliava troppo.
    const testoPulito = ripulisci(email.body_text, riconoscimento.testo)

    // Un'email vecchia entra già chiusa: serve nello storico e nella
    // ricerca, non in coda. Senza questo, importare tre mesi di casella
    // produce trecento ticket "in ritardo di 2000 ore" che nascondono i
    // pochi a cui bisogna davvero rispondere oggi.
    const etaGiorni = (Date.now() - arrivata.getTime()) / 86_400_000
    const vecchia = etaGiorni > opzioni.giorni_coda

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
            ${email.subject},
            ${vecchia ? 'closed' : agg.order_id ? 'new' : 'unmatched'},
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
            ${vecchia ? 'closed' : 'unmatched'}, ${arrivata}, ${arrivata}, ${scadenza}
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
        ${email.in_reply_to}, ${testoPulito}, ${email.body_html},
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
    for (const a of allegatiPronti) {
      await tx`
        insert into attachment (
          message_id, direzione, nome_file, mime, dimensione_byte, checksum,
          storage_path, larghezza, altezza
        ) values (
          ${messaggio.id}, 'in', ${a.nome_file}, ${a.mime},
          ${a.dimensione_byte}, ${a.checksum},
          ${a.storage_path}, ${a.larghezza}, ${a.altezza}
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
        -- Un'email vecchia non riapre niente: importare lo storico non
        -- deve far risalire in coda conversazioni concluse mesi fa.
        -- 'pending_internal' è lo stato di un ticket collegato (migrazione
        -- 0026, in attesa di corriere/assistenza): senza riaprirlo qui,
        -- la loro risposta si aggancerebbe comunque al thread giusto
        -- (aggancia.ts, strategia THREAD) ma resterebbe invisibile per
        -- sempre in "in attesa".
        state            = case
                             when ${vecchia} then state
                             when state = 'unmatched' and ${agg.order_id}::uuid is not null then 'open'
                             when state in ('closed', 'pending_customer', 'pending_internal') then 'open'
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
