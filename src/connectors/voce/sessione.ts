import { createHash, randomBytes } from 'node:crypto'

import type { Db } from '../../db/index.js'
import { DURATA_SESSIONE_MINUTI, MASSIMO_TENTATIVI, soloCifre } from '../../core/voce/verifica.js'

/**
 * Sessioni dell'agente vocale: dopo la verifica, l'agente riceve un token
 * legato a UN ordine e da lì in avanti può chiedere solo di quello. Non
 * esiste uno strumento che accetti un numero d'ordine senza verifica.
 *
 * In `voice_session` si salva l'impronta SHA-256 del token, non il token:
 * chi legge la tabella non può riusarlo per interrogare un ordine.
 */

export interface OrdineTrovato {
  id: string
  channel: string
  operator: string | null
  email: string | null
  cap: string | null
  nome: string | null
  raw: unknown
}

const impronta = (token: string) => createHash('sha256').update(token).digest('hex')

/** Riferimenti più corti di così corrispondono a troppi ordini per essere una verifica. */
const LUNGHEZZA_MINIMA = 3

/**
 * Gli ordini il cui numero (del canale o del negozio) coincide con quello
 * dettato, confrontati nella forma ridotta di `riduciRiferimento()`.
 * Ripetere la riduzione in SQL è un'operazione su qualche migliaio di
 * righe: millisecondi, senza un indice dedicato.
 */
export async function cercaOrdiniPerRiferimento(db: Db, ridotto: string): Promise<OrdineTrovato[]> {
  if (ridotto.length < LUNGHEZZA_MINIMA) return []
  const prefissoLettere = soloCifre(ridotto) ? `^[A-Z]+${ridotto}$` : null
  return db<OrdineTrovato[]>`
    select id, channel, operator, email,
           shipping_address->>'cap' as cap,
           shipping_address->>'nome' as nome,
           raw
    from "order"
    where regexp_replace(upper(external_order_id), '[^A-Z0-9]', '', 'g') = ${ridotto}
       or regexp_replace(upper(coalesce(shopify_name, '')), '[^A-Z0-9]', '', 'g') = ${ridotto}
       or (${prefissoLettere}::text is not null
           and regexp_replace(upper(coalesce(shopify_name, '')), '[^A-Z0-9]', '', 'g') ~ ${prefissoLettere}::text)
    order by placed_at desc nulls last
    limit 5
  `
}

/** Tentativi falliti in questa telefonata: oltre il massimo la verifica si blocca. */
export async function tentativiEsauriti(db: Db, conversationId: string): Promise<boolean> {
  const [riga] = await db<{ n: number }[]>`
    select count(*)::int as n from voice_log
    where conversation_id = ${conversationId}
      and tool = 'verifica-cliente'
      and esito in ('ordine_non_trovato', 'dati_non_corrispondenti', 'dati_non_disponibili')
  `
  return (riga?.n ?? 0) >= MASSIMO_TENTATIVI
}

export async function creaSessione(db: Db, conversationId: string, orderId: string): Promise<string> {
  const token = randomBytes(24).toString('base64url')
  await db`
    insert into voice_session (conversation_id, token_hash, order_id, expires_at)
    values (
      ${conversationId}, ${impronta(token)}, ${orderId},
      now() + make_interval(mins => ${DURATA_SESSIONE_MINUTI})
    )
  `
  return token
}

/** L'ordine legato a un token ancora valido, o null. */
export async function ordineDellaSessione(db: Db, token: string): Promise<string | null> {
  const [riga] = await db<{ order_id: string }[]>`
    select order_id from voice_session
    where token_hash = ${impronta(token)} and expires_at > now()
  `
  return riga?.order_id ?? null
}

/**
 * Il marchio del frontend da cui è partito l'ordine, se il negozio lo
 * scrive negli attributi dell'ordine (`_brand`). Le due forme sono quella
 * GraphQL (`customAttributes`, chiave `key`) e quella dei webhook
 * (`note_attributes`, chiave `name`).
 */
export function marchioDaRaw(raw: unknown): string | null {
  const r = (raw ?? {}) as { customAttributes?: unknown; note_attributes?: unknown }
  const elenchi = [r.customAttributes, r.note_attributes].filter(Array.isArray) as unknown[][]
  for (const elenco of elenchi) {
    for (const a of elenco) {
      const voce = a as { key?: unknown; name?: unknown; value?: unknown }
      const chiave = voce.key ?? voce.name
      if (chiave === '_brand' && typeof voce.value === 'string' && voce.value.trim()) {
        return voce.value.trim()
      }
    }
  }
  return null
}
