import type { Db } from '../../db/index.js'
import type { TipoReso } from '../../core/reso/foglio.js'

/**
 * Testo del messaggio al cliente per un reso, preso dai modelli già nel
 * database (tabella `template`, gli stessi dell'editor): uno per tipologia.
 * Sostituisce solo {{cliente.nome}} e {{ordine.numero}}; ogni altro segnaposto
 * resta com'è, così si vede e si corregge a mano prima di incollare.
 */

export const MODELLO_PER_TIPO: Record<TipoReso, string> = {
  recesso: 'Reso Recesso',
  danneggiato: 'Reso Danneggiato',
  verificare: 'Reso Verificare',
}

/** "MARIO ROSSI" diventa "Mario Rossi"; un nome già scritto bene non si tocca. */
export function nomePerSaluto(nome: string): string {
  const pulito = nome.trim()
  if (!pulito) return pulito
  if (pulito !== pulito.toUpperCase()) return pulito
  return pulito.toLowerCase().replace(/(^|[\s'’-])(\p{L})/gu, (_m, sep: string, c: string) => sep + c.toUpperCase())
}

export function compilaModello(testo: string, dati: { nome_cliente: string; numero_ordine: string }): string {
  return testo
    .replace(/\{\{\s*cliente\.nome\s*\}\}/g, nomePerSaluto(dati.nome_cliente))
    .replace(/\{\{\s*ordine\.numero\s*\}\}/g, dati.numero_ordine)
}

export interface TestoReso {
  modello: string
  oggetto: string | null
  testo: string
}

export async function testoReso(
  db: Db,
  tipo: TipoReso,
  dati: { nome_cliente: string; numero_ordine: string },
): Promise<TestoReso | null> {
  const nome = MODELLO_PER_TIPO[tipo]
  const [m] = await db<{ subject_tpl: string | null; body_tpl: string | null }[]>`
    select subject_tpl, body_tpl from template where name = ${nome} and locale = 'it' limit 1
  `
  if (!m?.body_tpl) return null
  return {
    modello: nome,
    oggetto: m.subject_tpl ? compilaModello(m.subject_tpl, dati) : null,
    testo: compilaModello(m.body_tpl, dati),
  }
}
