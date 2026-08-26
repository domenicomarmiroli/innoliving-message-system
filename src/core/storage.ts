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
 * Codifica ogni segmento del percorso separatamente, preservando le "/".
 * Senza questo, un nome file con uno spazio o un carattere speciale (gli
 * screenshot di Windows/macOS ne sono pieni: "Screenshot 2026-08-26
 * 173654.png") produce un URL non valido e Storage risponde 400 — non
 * un errore raro, il caso comune di ogni file scaricato da un telefono
 * o da uno strumento di cattura schermo.
 */
function codificaPercorso(percorso: string): string {
  return percorso.split('/').map(encodeURIComponent).join('/')
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

  const url = `${config.SUPABASE_URL}/storage/v1/object/${BUCKET}/${codificaPercorso(percorso)}`
  const risposta = await fetch(url, {
    method: 'POST',
    headers: {
      // Serve sempre anche apikey, non solo Authorization: è così che il
      // gateway di Supabase identifica il progetto prima ancora di
      // guardare il token. Senza, risponde con un errore che non dice
      // "manca l'apikey" — dice solo che la richiesta non va bene.
      apikey: config.SUPABASE_SERVICE_ROLE_KEY!,
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

/**
 * Scarica un file dal bucket. `percorso` accetta sia `allegati/x/y` (come
 * restituito da caricaAllegato) sia `x/y` da solo: entrambi finiscono
 * sullo stesso oggetto.
 */
export async function scaricaAllegato(config: Config, percorso: string): Promise<Buffer> {
  if (!storageConfigurato(config)) {
    throw new Error('Storage non configurato: mancano SUPABASE_URL e/o SUPABASE_SERVICE_ROLE_KEY.')
  }

  const senzaPrefisso = percorso.startsWith(`${BUCKET}/`) ? percorso.slice(BUCKET.length + 1) : percorso
  const url = `${config.SUPABASE_URL}/storage/v1/object/${BUCKET}/${codificaPercorso(senzaPrefisso)}`
  const risposta = await fetch(url, {
    headers: {
      apikey: config.SUPABASE_SERVICE_ROLE_KEY!,
      Authorization: `Bearer ${config.SUPABASE_SERVICE_ROLE_KEY}`,
    },
  })
  if (!risposta.ok) {
    throw new Error(`Download da Storage fallito (${risposta.status}): ${percorso}`)
  }
  return Buffer.from(await risposta.arrayBuffer())
}
