import { createHash } from 'node:crypto'

import type { Config } from '../../config.js'
import type { Db } from '../../db/index.js'
import type { Logger } from '../../logger.js'
import type { FilePronto } from '../../core/attachments/normalize.js'
import { caricaAllegato, storageConfigurato } from '../../core/storage.js'
import { dimensioniImmagine } from '../../core/immagine.js'
import { normalizzaMessageId } from './parse.js'
import { creaTrasporto } from './invia.js'

/**
 * Ticket collegati — "linked tickets" stile Zendesk (migrazione 0026).
 *
 * Un agente, dal ticket cliente, scrive una email a un indirizzo esterno
 * (corriere, assistenza) per lo stesso argomento. Non è una risposta sul
 * thread esistente: è un NUOVO ticket, `pending_internal` ("in attesa"),
 * con `thread.linked_thread_id` che punta al ticket cliente di partenza.
 *
 * La risposta del corriere/assistenza si aggancia da sola al giro IMAP
 * successivo: `aggancia.ts` (strategia THREAD) trova il nostro
 * `rfc822_id` in In-Reply-To/References indipendentemente dal canale, e
 * `upsert.ts` riporta il thread da `pending_internal` a `open`. Nessun
 * codice di matching nuovo qui.
 */

export type TipoCollegamento = 'corriere' | 'assistenza' | 'altro'

export interface RichiestaTicketCollegato {
  /** Il ticket cliente da cui si apre il nuovo ticket. */
  thread_id: string
  agent_id: string | null
  destinatario: string
  testo: string
  oggetto?: string | null
  tipo?: TipoCollegamento
  allegati?: FilePronto[]
}

export interface EsitoTicketCollegato {
  /** Il NUOVO thread creato, non quello di partenza. */
  thread_id: string
  message_id: string
  rfc822_id: string | null
}

const ETICHETTA_TIPO: Record<TipoCollegamento, string> = {
  corriere: 'Corriere',
  assistenza: 'Assistenza',
  altro: 'Contatto esterno',
}

/**
 * L'oggetto dell'email: quello scelto dall'agente se c'è, altrimenti
 * un'etichetta leggibile costruita dal tipo e, se il ticket di partenza
 * ha un ordine, dal suo riferimento — stesso principio di
 * `contatti.ts` ("Contatto dal sito — ordine ...").
 */
export function costruisciOggetto(
  tipo: TipoCollegamento,
  oggettoRichiesto: string | null | undefined,
  riferimentoOrdine: string | null,
): string {
  const scelto = oggettoRichiesto?.trim()
  if (scelto) return scelto
  const etichetta = ETICHETTA_TIPO[tipo]
  return riferimentoOrdine ? `${etichetta} — ordine ${riferimentoOrdine}` : etichetta
}

/**
 * I tag scritti sul nuovo thread: uno generico (per una futura vista
 * dedicata, stesso schema di 'reso-richiesto'/'rimborso-emesso') e uno
 * specifico per tipo.
 */
export function tagCollegato(tipo: TipoCollegamento): string[] {
  return ['ticket-collegato', `collegato-${tipo}`]
}

export async function apriTicketCollegato(
  db: Db,
  log: Logger,
  config: Config,
  richiesta: RichiestaTicketCollegato,
): Promise<EsitoTicketCollegato> {
  const tipo = richiesta.tipo ?? 'altro'

  const [padre] = await db<
    { id: string; order_id: string | null; assignee_id: string | null }[]
  >`
    select id, order_id, assignee_id from thread where id = ${richiesta.thread_id}
  `
  if (!padre) {
    throw new Error(`Il ticket ${richiesta.thread_id} non esiste.`)
  }

  const [ordine] = padre.order_id
    ? await db<{ shopify_name: string | null; external_order_id: string }[]>`
        select shopify_name, external_order_id from "order" where id = ${padre.order_id}
      `
    : []
  const riferimentoOrdine = ordine?.shopify_name ?? ordine?.external_order_id ?? null

  const [casella] = await db<{ id: string; sla_minutes: number }[]>`
    select id, sla_minutes from channel_account where kind = 'email' and active limit 1
  `
  if (!casella) {
    throw new Error(
      "Manca l'account della casella (kind='email') in channel_account: impossibile aprire un ticket collegato.",
    )
  }

  const oggetto = costruisciOggetto(tipo, richiesta.oggetto, riferimentoOrdine)
  const ora = new Date()
  const scadenza = new Date(ora.getTime() + casella.sla_minutes * 60_000)

  // Spedizione via SMTP prima di aprire la transazione: è I/O di rete,
  // stessa regola già scritta in upsert.ts per gli allegati.
  const inviato = await creaTrasporto(config).sendMail({
    from: config.MAIL_USER,
    to: richiesta.destinatario,
    subject: oggetto,
    text: richiesta.testo,
    attachments: richiesta.allegati?.map((a) => ({
      filename: a.nome_file,
      content: a.contenuto,
      contentType: a.mime,
    })),
  })
  const rfc822 = normalizzaMessageId(inviato.messageId ?? null)

  const risultato = await db.begin(async (tx) => {
    const [nuovo] = await tx<{ id: string }[]>`
      insert into thread (
        account_id, order_id, subject, state, linked_thread_id,
        assignee_id, tags, due_at
      ) values (
        ${casella.id}, ${padre.order_id}, ${oggetto}, 'pending_internal', ${padre.id},
        ${richiesta.agent_id ?? padre.assignee_id}, ${tagCollegato(tipo)}, ${scadenza}
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
        ${tx.json({ to: richiesta.destinatario, subject: oggetto, accepted: inviato.accepted })}
      )
      returning id
    `
    const messageId = riga!.id

    // Gli allegati spediti davvero, stesso schema di invia.ts: registrati
    // COSÌ COME SONO PARTITI, per mostrare in cronologia cosa è stato
    // ricevuto, non cosa l'agente aveva scelto prima di un'eventuale
    // conversione.
    for (const a of richiesta.allegati ?? []) {
      const checksum = createHash('sha256').update(a.contenuto).digest('hex')
      let storage_path: string | null = null
      if (storageConfigurato(config)) {
        try {
          storage_path = await caricaAllegato(
            config,
            `out/${messageId}/${checksum}-${a.nome_file}`,
            a.contenuto,
            a.mime,
          )
        } catch (errore) {
          log.error(
            { err: errore instanceof Error ? errore.message : String(errore) },
            "upload su Storage dell'allegato in uscita fallito: registrato solo il metadato",
          )
        }
      }
      const dimensioni = await dimensioniImmagine(a.contenuto)
      await tx`
        insert into attachment (
          message_id, direzione, nome_file, mime, dimensione_byte, checksum,
          storage_path, convertito_da, larghezza, altezza
        ) values (
          ${messageId}, 'out', ${a.nome_file}, ${a.mime}, ${a.contenuto.byteLength}, ${checksum},
          ${storage_path}, ${a.convertito_da}, ${dimensioni?.larghezza ?? null}, ${dimensioni?.altezza ?? null}
        )
      `
    }

    if (richiesta.agent_id) {
      await tx`
        insert into audit_log (agent_id, azione, entita, entita_id, dati)
        values (${richiesta.agent_id}, 'ticket_collegato_aperto', 'thread', ${threadId},
                ${tx.json({ thread_padre: padre.id, tipo })})
      `
    }

    return { thread_id: threadId, message_id: messageId }
  })

  log.info(
    { thread_id_padre: richiesta.thread_id, thread_id: risultato.thread_id },
    'ticket collegato aperto e messaggio inviato',
  )

  return { thread_id: risultato.thread_id, message_id: risultato.message_id, rfc822_id: rfc822 }
}
