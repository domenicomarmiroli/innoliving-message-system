import type { Config } from '../config.js'

/**
 * Caricamento dei byte degli allegati su Supabase Storage.
 *
 * Chiamate REST dirette, non l'SDK @supabase/supabase-js: per un solo
 * upload non serve un client intero, e resta coerente con postgres.js
 * per il database — niente ORM o SDK pesanti dove basta una fetch.
 *
 * Il bucket è privato (migrazione 0008): la lettura richiede un URL
 * firmato, mai un link diretto permanente.
 */

const BUCKET = 'allegati'

export function storageConfigurato(config: Config): boolean {
  return Boolean(config.SUPABASE_URL && config.SUPABASE_SERVICE_ROLE_KEY)
}

/**
 * Carica un file e restituisce il percorso nel bucket. `x-upsert: true`
 * rende l'operazione idempotente sullo stesso percorso: rielaborare la
 * stessa email non fallisce sull'allegato già presente.
 */
export async function caricaAllegato(
  config: Config,
  percorso: string,
  contenuto: Buffer,
  mime: string | null,
): Promise<string> {
  if (!storageConfigurato(config)) {
    throw new Error(
      'Storage non configurato: mancano SUPABASE_URL e/o SUPABASE_SERVICE_ROLE_KEY.',
    )
  }

  const url = `${config.SUPABASE_URL}/storage/v1/object/${BUCKET}/${percorso}`
  const risposta = await fetch(url, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${config.SUPABASE_SERVICE_ROLE_KEY}`,
      'Content-Type': mime && mime.trim() ? mime : 'application/octet-stream',
      'x-upsert': 'true',
    },
    body: new Uint8Array(contenuto),
  })

  if (!risposta.ok) {
    const testo = await risposta.text().catch(() => '')
    throw new Error(`Upload su Storage fallito (${risposta.status}): ${testo.slice(0, 300)}`)
  }

  return `${BUCKET}/${percorso}`
}
