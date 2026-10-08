/**
 * Stato della pratica di assistenza o di reso, e l'avviso al cliente che
 * ne segue (migrazione 0044). La parte pura: quale stato, quale testo.
 *
 * Nato dal report sulle conversazioni del partner garanzie (08/10): la
 * domanda più frequente era "a che punto è?". Un messaggio a ogni cambio
 * di stato toglie la domanda prima che nasca.
 */

export const STATI_PRATICA = [
  'ricevuta',
  'etichetta_inviata',
  'rientrata',
  'rientrata_sostituzione',
  'rientrata_sostituzione_altro_modello',
  'rientrata_riparazione',
  'rientrata_funzionante',
  'rientrata_non_conforme',
  'spedita',
  'chiusa',
] as const
export type StatoPratica = (typeof STATI_PRATICA)[number]

/** Gli stati che l'operatore imposta a mano; gli altri li deduce il worker. */
export const STATI_OPERATORE = ['etichetta_inviata', 'spedita', 'chiusa'] as const satisfies readonly StatoPratica[]

/** "chiusa" non ha un avviso: il ticket chiuso parla da sé, e un'email "pratica chiusa" sembra un congedo. */
export const STATI_SENZA_AVVISO: readonly StatoPratica[] = ['chiusa']

/** Canali in cui scriviamo noi al cliente. Su Amazon e Mirakl lo informa il marketplace. */
export const CANALI_CON_AVVISO = ['email', 'contatto', 'telefono', 'shopify']

/**
 * L'esito registrato dal magazzino alla scansione del rientro (campo
 * `action` del tool "Utilities Magazzino", valori letti sui dati veri del
 * 08/10). Un esito sconosciuto vale "rientrata" senza esito: il cliente
 * sa comunque che il prodotto è arrivato.
 */
export function statoDaEsitoMagazzino(action: string | null | undefined): StatoPratica {
  switch (action) {
    case 'sostituzione':
    case 'carico_e_sostituzione':
      return 'rientrata_sostituzione'
    case 'sostituzione_altro_modello':
      return 'rientrata_sostituzione_altro_modello'
    case 'riparazione':
      return 'rientrata_riparazione'
    case 'funzionante_rinvio':
      return 'rientrata_funzionante'
    case 'non_conformita':
      return 'rientrata_non_conforme'
    default:
      return 'rientrata'
  }
}

/**
 * Il nostro numero di ticket dal campo "pratica" del rientro. Il magazzino
 * lo scrive come lo trova sulla pratica: "12119", "#12119", "TK-12119".
 * Un numero del partner ("GGF-1499") non è nostro e resta null: legarlo a
 * un ticket a caso sarebbe peggio di non legarlo.
 */
export function numeroTicketDaPratica(pratica: string | null | undefined): number | null {
  if (!pratica) return null
  const m = pratica.trim().match(/^(?:#|tk[- ]?|ticket[- ]?)?(\d{4,9})$/i)
  return m ? Number(m[1]) : null
}

export interface DatiAvviso {
  numero: string
  tracking?: string | null
  corriere?: string | null
  link_tracking?: string | null
}

/** Riempie il testo; una riga che resta con un segnaposto vuoto sparisce invece di mostrare "Corriere: ". */
export function componiAvviso(modello: string, d: DatiAvviso): string {
  const valori: Record<string, string> = {
    numero: d.numero,
    tracking: d.tracking?.trim() ?? '',
    corriere: d.corriere?.trim() ?? '',
    link_tracking: d.link_tracking?.trim() ?? '',
  }
  return modello
    .split('\n')
    .filter((riga) => !/\{(\w+)\}/.test(riga) || [...riga.matchAll(/\{(\w+)\}/g)].every((m) => (valori[m[1]!] ?? '') !== ''))
    .map((riga) => riga.replace(/\{(\w+)\}/g, (_, k: string) => valori[k] ?? ''))
    .join('\n')
    .trim()
}
