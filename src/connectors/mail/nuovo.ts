import type { Config } from '../../config.js'
import type { Db } from '../../db/index.js'
import type { Logger } from '../../logger.js'
import type { FilePronto } from '../../core/attachments/normalize.js'
import { casellaPerTrasporto } from './casella.js'
import { registraAllegatiUscita } from './collega.js'
import { adattaAllegatiAlTrasporto, spedisci } from './spedizione.js'

/**
 * Ticket aperto da noi: l'agente scrive per primo a un cliente.
 *
 * Parte SEMPRE dalla casella Microsoft (transport 'graph', indirizzo in
 * MS_MAILBOX): è la casella aziendale dei ticket, e la risposta del
 * cliente deve rientrare nella stessa. Niente ripiego su Gmail: meglio un
 * errore che dice cosa manca di un'email partita dall'identità sbagliata.
 *
 * Nasce `pending_customer`. La risposta del cliente si aggancia da sola
 * (strategia THREAD di `aggancia.ts`, sul nostro `rfc822_id`) e
 * `upsert.ts` riporta il ticket a `open`. Le risposte successive passano
 * da `inviaRisposta()`, che senza messaggi in arrivo riusa `raw.to` e
 * `raw.trasporto` del nostro invio.
 */

export interface RichiestaNuovoTicket {
  agent_id: string | null
  destinatario: string
  oggetto: string
  testo: string
  allegati?: FilePronto[]
}

export interface EsitoNuovoTicket {
  thread_id: string
  message_id: string
  rfc822_id: string | null
}

export const TAG_NUOVO_TICKET = 'aperto-da-operatore'

export async function apriTicketInUscita(
  db: Db,
  log: Logger,
  config: Config,
  richiesta: RichiestaNuovoTicket,
): Promise<EsitoNuovoTicket> {
  const trasporto = 'graph' as const
  const casella = await casellaPerTrasporto(db, trasporto)

  const ora = new Date()
  const scadenza = new Date(ora.getTime() + casella.sla_minutes * 60_000)

  // Spedizione prima della transazione: è I/O di rete.
  const allegati = await adattaAllegatiAlTrasporto(trasporto, richiesta.allegati ?? [])
  const inviato = await spedisci(config, log, trasporto, {
    a: richiesta.destinatario,
    oggetto: richiesta.oggetto,
    testo: richiesta.testo,
    ...(allegati.length > 0 ? { allegati } : {}),
  })
  const rfc822 = inviato.rfc822_id

  const risultato = await db.begin(async (tx) => {
    const [nuovo] = await tx<{ id: string }[]>`
      insert into thread (account_id, subject, state, assignee_id, tags, due_at)
      values (
        ${casella.account_id}, ${richiesta.oggetto}, 'pending_customer',
        ${richiesta.agent_id}, ${[TAG_NUOVO_TICKET]}, ${scadenza}
      )
      returning id
    `
    const threadId = nuovo!.id

    const [riga] = await tx<{ id: string }[]>`
      insert into message (
        thread_id, direction, author_kind, external_id, rfc822_id,
        body_text, sent_at, delivery_state, agent_id, raw
      ) values (
        ${threadId}, 'out', 'agent', ${rfc822}, ${rfc822},
        ${richiesta.testo}, ${ora}, 'inviato', ${richiesta.agent_id},
        ${tx.json({ to: richiesta.destinatario, subject: richiesta.oggetto, accepted: inviato.accettati, trasporto })}
      )
      returning id
    `
    const messageId = riga!.id

    await registraAllegatiUscita(tx, log, config, messageId, allegati)

    if (richiesta.agent_id) {
      await tx`
        insert into audit_log (agent_id, azione, entita, entita_id, dati)
        values (${richiesta.agent_id}, 'ticket_aperto_in_uscita', 'thread', ${threadId},
                ${tx.json({ destinatario: richiesta.destinatario })})
      `
    }

    return { thread_id: threadId, message_id: messageId }
  })

  log.info({ thread_id: risultato.thread_id }, 'ticket in uscita aperto e messaggio inviato')
  return { ...risultato, rfc822_id: rfc822 }
}
