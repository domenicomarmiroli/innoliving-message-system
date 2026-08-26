import type { Db } from '../../db/index.js'
import type { Logger } from '../../logger.js'
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
