import type { Db } from '../../db/index.js'
import type { EmailGrezza, Riconoscimento, StrategiaMatch } from './tipi.js'

/**
 * A quale ordine e a quale conversazione appartiene questa email.
 *
 * Tre strade, in ordine di affidabilità decrescente. La prima che dà un
 * risultato vince; nessuna ipotesi sul layout delle email.
 *
 *  1. THREAD — In-Reply-To o References puntano a un messaggio già nostro.
 *     È il caso di ogni risposta successiva alla prima, ed è esatto.
 *
 *  2. ALIAS — l'indirizzo del relay corrisponde a order.buyer_alias.
 *     Verificato sui dati reali: 214 ordini Mirakl su 214 hanno l'alias.
 *     Per Amazon l'alias non arriva dall'ordine importato, quindi qui
 *     resta a mani vuote e si passa al punto 3.
 *
 *  3. NUMERO D'ORDINE — la stringa nel testo, per i formati con una forma
 *     fissa (Amazon). Meno solido: il numero potrebbe comparire in una
 *     citazione, quindi lo usiamo solo se l'alias non ha risolto.
 *
 * Se nessuna funziona il thread nasce `unmatched`. Non è un errore: è un
 * messaggio che un operatore aggancerà a mano, e intanto non si perde.
 */

export interface Aggancio {
  order_id: string | null
  thread_id: string | null
  strategia: StrategiaMatch
}

export async function aggancia(
  db: Db,
  email: EmailGrezza,
  riconoscimento: Riconoscimento,
): Promise<Aggancio> {
  // --- 1. La conversazione esiste già? ---------------------------------
  const catena = [email.in_reply_to, ...email.references].filter(
    (x): x is string => !!x,
  )
  if (catena.length > 0) {
    const [precedente] = await db<{ thread_id: string; order_id: string | null }[]>`
      select m.thread_id, t.order_id
      from message m
      join thread t on t.id = m.thread_id
      where m.rfc822_id = any(${catena})
      order by m.sent_at desc
      limit 1
    `
    if (precedente) {
      return {
        order_id: precedente.order_id,
        thread_id: precedente.thread_id,
        strategia: 'thread',
      }
    }
  }

  // --- 2. L'alias del relay corrisponde a un ordine? -------------------
  if (riconoscimento.alias) {
    const [perAlias] = await db<{ id: string }[]>`
      select id from "order"
      where lower(buyer_alias) = ${riconoscimento.alias.toLowerCase()}
      order by placed_at desc nulls last
      limit 1
    `
    if (perAlias) {
      return { order_id: perAlias.id, thread_id: null, strategia: 'alias' }
    }
  }

  // --- 3. Il numero d'ordine nel testo ---------------------------------
  if (riconoscimento.numero_ordine) {
    const [perNumero] = await db<{ id: string }[]>`
      select id from "order"
      where external_order_id = ${riconoscimento.numero_ordine}
         or shopify_name      = ${riconoscimento.numero_ordine}
      order by placed_at desc nulls last
      limit 1
    `
    if (perNumero) {
      return { order_id: perNumero.id, thread_id: null, strategia: 'numero_ordine' }
    }
  }

  return { order_id: null, thread_id: null, strategia: 'nessuna' }
}

/**
 * L'identificativo stabile della conversazione lato marketplace.
 *
 * Non abbiamo un ID di thread fornito dal relay, quindi lo costruiamo:
 * account + ordine quando l'ordine c'è, altrimenti account + alias del
 * mittente. Serve al vincolo unique (account_id, external_thread_id), che
 * impedisce a due email dello stesso cliente sullo stesso ordine di
 * diventare due conversazioni separate.
 */
export function chiaveThread(
  riconoscimento: Riconoscimento,
  order_id: string | null,
): string | null {
  if (order_id) return `ordine:${order_id}`
  if (riconoscimento.alias) return `mittente:${riconoscimento.alias.toLowerCase()}`
  return null
}
