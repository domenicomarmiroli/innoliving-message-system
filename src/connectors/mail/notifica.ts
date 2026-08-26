import type { Db } from '../../db/index.js'
import type { Logger } from '../../logger.js'
import { perArchivio } from './parse.js'
import { estraiNumeroOrdine } from './riconosci.js'
import type { EmailGrezza } from './tipi.js'

/**
 * Avvisi di mancata consegna.
 *
 * Amazon manda una email quando un nostro messaggio non raggiunge
 * l'acquirente — filtro antifrode, thread già chiuso, acquirente che ha
 * disattivato i messaggi. Non è una richiesta: non c'è niente a cui
 * rispondere, e aprirci un ticket sopra riempirebbe la coda di lavoro
 * che non esiste.
 *
 * Ma è un'informazione che serve, e serve *dove serve*: sulla
 * conversazione di quel cliente. Sapere che la risposta non è arrivata
 * cambia cosa fai dopo — richiami, riprovi dal pannello, o accetti che
 * il cliente non sappia niente.
 *
 * Quindi: nessun ticket nuovo, un segno sulla conversazione esistente.
 */

export type EsitoNotifica =
  | 'agganciata' // segnata sulla conversazione dell'ordine
  | 'orfana' // nessun ordine riconosciuto: registrata in ingest_anomaly
  | 'gia_vista' // già elaborata in un giro precedente

export const TAG_CONSEGNA_FALLITA = 'consegna-fallita'

export async function registraNotifica(
  db: Db,
  log: Logger,
  email: EmailGrezza,
  accountId: string,
  orderIdPattern: string | null,
): Promise<EsitoNotifica> {
  const numero = estraiNumeroOrdine(email, orderIdPattern)

  if (!numero) {
    await anomalia(db, accountId, 'notifica_senza_ordine', email)
    return 'orfana'
  }

  return db.begin(async (tx) => {
    // La conversazione di quell'ordine, se esiste. Non ne creiamo una:
    // se il cliente non ci ha mai scritto attraverso l'hub non c'è
    // niente da annotare, e inventarla sarebbe rumore.
    const [thread] = await tx<{ id: string; tags: string[] }[]>`
      select t.id, t.tags
      from thread t
      join "order" o on o.id = t.order_id
      where o.external_order_id = ${numero}
      order by t.last_inbound_at desc nulls last
      limit 1
    `

    if (!thread) {
      await anomalia(db, accountId, 'notifica_ordine_sconosciuto', email, numero)
      return 'orfana'
    }

    if (thread.tags.includes(TAG_CONSEGNA_FALLITA)) return 'gia_vista'

    // L'ultima risposta che abbiamo mandato noi, se l'abbiamo mandata da
    // qui. Finché le risposte partono dal pannello Amazon questa non
    // esiste, e va bene: il segno sulla conversazione resta comunque.
    await tx`
      update message set delivery_state = 'non_consegnato', updated_at = now()
      where id = (
        select id from message
        where thread_id = ${thread.id} and direction = 'out'
        order by sent_at desc
        limit 1
      )
    `

    await tx`
      update thread set
        tags       = array_append(tags, ${TAG_CONSEGNA_FALLITA}),
        -- Torna visibile: una risposta non arrivata è lavoro rimasto
        -- aperto, anche se la conversazione sembrava chiusa.
        state      = case when state = 'closed' then 'open' else state end,
        updated_at = now()
      where id = ${thread.id}
    `

    log.warn(
      { thread_id: thread.id, ordine: numero },
      'risposta non consegnata al cliente: conversazione riaperta',
    )
    return 'agganciata'
  })
}

async function anomalia(
  db: Db,
  accountId: string,
  tipo: string,
  email: EmailGrezza,
  numero?: string,
): Promise<void> {
  // Una notifica che non riusciamo ad agganciare non si butta: se sono
  // tante vuol dire che il riconoscimento del numero d'ordine non
  // funziona su questo formato, ed è qui che lo si scopre.
  try {
    await db`
      insert into ingest_anomaly (account_id, tipo, payload)
      values (${accountId}, ${tipo}, ${db.json({
        subject: email.subject,
        rfc822_id: email.rfc822_id,
        numero_ordine: numero ?? null,
      })})
    `
  } catch {
    /* il database è irraggiungibile: se ne accorgerà il ciclo */
  }
}

/**
 * Avvisi su un ordine: garanzia dalla A alla Z, richieste di rimborso.
 *
 * Sono la cosa più urgente che passa dalla casella. Una richiesta di
 * garanzia dalla A alla Z non gestita pesa sulla salute dell'account
 * venditore, e per quelle Amazon non offre nessuna API: questa email è
 * l'unico modo che abbiamo di sapere che esiste.
 *
 * A differenza degli avvisi di mancata consegna, qui la conversazione
 * si crea anche se non c'è: un reclamo su un ordine di cui il cliente
 * non ci ha mai scritto è comunque lavoro, e non averlo in coda
 * significa scoprirlo quando è tardi.
 */
export interface EsitoAvviso {
  esito: 'aperto' | 'aggiornato' | 'gia_visto' | 'orfano'
  thread_id: string | null
  tag: string
}

export function tagDaOggetto(
  oggetto: string | null,
  regole: Array<[string, string]>,
): string {
  const testo = (oggetto ?? '').toLowerCase()
  for (const [quando, tag] of regole) {
    if (testo.includes(quando.toLowerCase())) return tag
  }
  return 'avviso-piattaforma'
}

export async function registraAvviso(
  db: Db,
  log: Logger,
  email: EmailGrezza,
  accountId: string,
  orderIdPattern: string | null,
  opzioni: {
    avviso_sla_minuti: number
    avviso_tag: Array<[string, string]>
    giorni_coda: number
  },
): Promise<EsitoAvviso> {
  const numero = estraiNumeroOrdine(email, orderIdPattern)
  const tag = tagDaOggetto(email.subject, opzioni.avviso_tag)

  if (!numero) {
    await anomalia(db, accountId, 'avviso_senza_ordine', email)
    return { esito: 'orfano', thread_id: null, tag }
  }

  const arrivato = email.date ?? new Date()
  // Anche gli avvisi rispettano la finestra: importare mesi di storico
  // non deve far squillare l'allarme su reclami già chiusi.
  const vecchio =
    (Date.now() - arrivato.getTime()) / 86_400_000 > opzioni.giorni_coda
  const scadenza = new Date(arrivato.getTime() + opzioni.avviso_sla_minuti * 60_000)

  return db.begin(async (tx) => {
    const [ordine] = await tx<{ id: string }[]>`
      select id from "order" where external_order_id = ${numero} limit 1
    `
    if (!ordine) {
      await anomalia(db, accountId, 'avviso_ordine_sconosciuto', email, numero)
      return { esito: 'orfano' as const, thread_id: null, tag }
    }

    // Stessa chiave che usa chiaveThread(): se il cliente scriverà di
    // quell'ordine finirà in QUESTA conversazione, non in una parallela.
    const chiave = `ordine:${ordine.id}`

    const [thread] = await tx<{ id: string; tags: string[]; created: boolean }[]>`
      insert into thread (
        account_id, external_thread_id, order_id, subject, state,
        first_inbound_at, last_inbound_at, due_at, tags
      ) values (
        ${accountId}, ${chiave}, ${ordine.id}, ${email.subject},
        ${vecchio ? 'closed' : 'open'}, ${arrivato}, ${arrivato}, ${scadenza},
        ${[tag]}
      )
      on conflict (account_id, external_thread_id)
        where external_thread_id is not null
      do update set updated_at = now()
      returning id, tags, (xmax = 0) as created
    `

    const t = thread!
    if (!t.created) {
      if (t.tags.includes(tag)) {
        return { esito: 'gia_visto' as const, thread_id: t.id, tag }
      }
      await tx`
        update thread set
          tags   = array_append(tags, ${tag}),
          -- Un avviso ha la precedenza sullo stato precedente: la
          -- scadenza è la sua, più corta di quella di un messaggio.
          state  = ${vecchio ? tx`state` : tx`'open'`},
          due_at = least(coalesce(due_at, ${scadenza}), ${scadenza}),
          updated_at = now()
        where id = ${t.id}
      `
    }

    await tx`
      insert into message (
        thread_id, direction, author_kind, external_id, rfc822_id,
        body_text, sent_at, match_strategy, raw
      ) values (
        ${t.id}, 'in', 'system', ${email.rfc822_id}, ${email.rfc822_id},
        ${email.body_text}, ${arrivato}, 'numero_ordine',
        ${tx.json(perArchivio(email) as never)}
      )
      on conflict (rfc822_id) where rfc822_id is not null do nothing
    `

    if (!vecchio) {
      log.warn({ thread_id: t.id, ordine: numero, tag }, 'avviso su ordine')
    }
    return {
      esito: t.created ? ('aperto' as const) : ('aggiornato' as const),
      thread_id: t.id,
      tag,
    }
  })
}
