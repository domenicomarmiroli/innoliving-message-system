import type { Db } from '../../db/index.js'

/**
 * Stato dei collegamenti esterni (migrazione 0053).
 *
 * Ogni giro e ogni invio dicono qui se il loro collegamento ha funzionato.
 * L'interfaccia legge `stato_collegamento` e mostra un avviso quando l'ultimo
 * errore è più recente dell'ultimo successo: senza, un disservizio di
 * Microsoft si scopre solo perché "la risposta non parte" (ticket 16121,
 * 13/11).
 *
 * Il database si imposta una volta all'avvio: così anche le funzioni che non
 * ricevono `db` (l'invio della posta) possono segnalare. Scrittura sempre
 * best effort: lo stato è un aiuto a vedere, non deve mai far fallire il
 * lavoro vero, e prima della migrazione la tabella non esiste.
 */

export type CodiceCollegamento =
  | 'casella-microsoft'
  | 'invio-microsoft'
  | 'casella-gmail'
  | 'invio-gmail'
  | 'mirakl'
  | 'invio-mirakl'
  | 'shopify'
  | 'brt'
  | 'magazzino'

export const NOMI_COLLEGAMENTO: Record<CodiceCollegamento, string> = {
  'casella-microsoft': 'Casella Microsoft (lettura)',
  'invio-microsoft': 'Casella Microsoft (invio)',
  'casella-gmail': 'Casella Gmail (lettura)',
  'invio-gmail': 'Casella Gmail (invio)',
  mirakl: 'Mirakl (lettura messaggi)',
  'invio-mirakl': 'Mirakl (invio risposte)',
  shopify: 'Shopify (ordini)',
  brt: 'BRT (tracking)',
  magazzino: 'Utilities Magazzino',
}

let dbStato: Db | null = null

export function impostaDbStato(db: Db): void {
  dbStato = db
}

/** Testo dell'errore, corto e senza a capo: finisce in un banner. */
export function riassumiErrore(errore: unknown): string {
  const testo = errore instanceof Error ? errore.message : String(errore)
  return testo.replace(/\s+/g, ' ').trim().slice(0, 300)
}

export async function segnalaStato(
  codice: CodiceCollegamento,
  errore: unknown = null,
  dettaglio: string | null = null,
): Promise<void> {
  const db = dbStato
  if (!db) return
  const ok = errore === null || errore === undefined
  const messaggio = ok ? null : riassumiErrore(errore)
  try {
    await db`
      insert into stato_collegamento
        (codice, nome, ultimo_ok_at, ultimo_errore_at, ultimo_errore, errori_consecutivi, dettaglio, aggiornato_at)
      values (${codice}, ${NOMI_COLLEGAMENTO[codice]},
              ${ok ? new Date() : null}, ${ok ? null : new Date()}, ${messaggio},
              ${ok ? 0 : 1}, ${dettaglio}, now())
      on conflict (codice) do update set
        nome               = excluded.nome,
        ultimo_ok_at       = coalesce(excluded.ultimo_ok_at, stato_collegamento.ultimo_ok_at),
        ultimo_errore_at   = coalesce(excluded.ultimo_errore_at, stato_collegamento.ultimo_errore_at),
        ultimo_errore      = coalesce(excluded.ultimo_errore, stato_collegamento.ultimo_errore),
        errori_consecutivi = case when ${ok} then 0 else stato_collegamento.errori_consecutivi + 1 end,
        dettaglio          = coalesce(excluded.dettaglio, stato_collegamento.dettaglio),
        aggiornato_at      = now()
    `
  } catch {
    /* tabella non ancora creata o database momentaneamente giù: si ignora */
  }
}
