/**
 * Stato di un ordine detto al telefono: la parte pura.
 *
 * L'agente vocale riceve solo valori già pronti da pronunciare — uno
 * stato fra pochi possibili, date come "28 settembre", righe come
 * "Stufa X (2 pz)" — e mai un timestamp o un codice interno da
 * interpretare: ogni interpretazione lasciata al modello è un'occasione
 * di dire una cosa non vera.
 *
 * "consegnato" viene solo dal gestionale (`order.spedizione_stato`, dal
 * pacchetto Zoho, migrazione 0033): né Shopify né i marketplace ci passano
 * l'avvenuta consegna (verificato il 05/10). Senza quel dato, meglio
 * "spedito" per un pacco già arrivato che "consegnato" per uno in giro.
 */

export type StatoOrdine =
  | 'in_attesa_pagamento'
  | 'in_preparazione'
  | 'spedito'
  | 'consegnato'
  | 'annullato'
  | 'rimborsato'
  | 'sconosciuto'

export interface DatiStato {
  financial_status: string | null
  fulfillment_status: string | null
  annullato_il: string | null
  placed_at?: Date | string | null
  /** Dal pacchetto del gestionale: 'non_spedito' | 'spedito' | 'consegnato'. */
  spedizione_stato?: string | null
}

/**
 * Oltre questi giorni, "pagato e non ancora spedito" non è più un dato
 * credibile: verificato il 05/10 che centinaia di ordini Amazon restano
 * non evasi su Shopify per settimane (spediti per altra via, mai
 * aggiornati). Dire "è in preparazione" a chi l'ha ricevuto un mese fa è
 * esattamente l'informazione inventata che l'agente non deve dare: in quel
 * caso lo stato è `sconosciuto` e l'agente apre un ticket.
 */
export const GIORNI_PREPARAZIONE_CREDIBILI = 7

const IN_PREPARAZIONE = new Set([
  'unfulfilled',
  'in_progress',
  'on_hold',
  'scheduled',
  'open',
  'pending_fulfillment',
  'request_declined',
])
const SPEDITO = new Set(['fulfilled'])
const SPEDITO_IN_PARTE = new Set(['partially_fulfilled', 'partial'])

/** I valori di Shopify arrivano in due grafie (GraphQL e webhook): si confrontano ridotti. */
const riduci = (v: string | null) => (v ?? '').trim().toLowerCase().replace(/\s+/g, '_')

export function statoOrdine(
  d: DatiStato,
  oggi: Date = new Date(),
): { stato: StatoOrdine; spedizione_parziale: boolean } {
  const pagamento = riduci(d.financial_status)
  const evasione = riduci(d.fulfillment_status)

  if (d.annullato_il || pagamento === 'voided' || evasione === 'restocked') {
    return { stato: 'annullato', spedizione_parziale: false }
  }
  if (pagamento === 'refunded') return { stato: 'rimborsato', spedizione_parziale: false }
  // Il gestionale vince su Shopify: per gli ordini Amazon Shopify resta
  // "non evaso" anche a pacco consegnato.
  if (d.spedizione_stato === 'consegnato') return { stato: 'consegnato', spedizione_parziale: false }
  if (d.spedizione_stato === 'spedito') return { stato: 'spedito', spedizione_parziale: false }
  if (SPEDITO.has(evasione)) return { stato: 'spedito', spedizione_parziale: false }
  if (SPEDITO_IN_PARTE.has(evasione)) return { stato: 'spedito', spedizione_parziale: true }
  if (pagamento === 'pending') return { stato: 'in_attesa_pagamento', spedizione_parziale: false }
  if (IN_PREPARAZIONE.has(evasione) || evasione === '') {
    const ordinato = d.placed_at ? new Date(d.placed_at).getTime() : NaN
    const giorni = (oggi.getTime() - ordinato) / 86_400_000
    if (Number.isNaN(giorni) || giorni > GIORNI_PREPARAZIONE_CREDIBILI) {
      return { stato: 'sconosciuto', spedizione_parziale: false }
    }
    return { stato: 'in_preparazione', spedizione_parziale: false }
  }
  return { stato: 'sconosciuto', spedizione_parziale: false }
}

const FUSO = 'Europe/Rome'

/**
 * "28 settembre", con l'anno solo se diverso da quello corrente: è così
 * che una persona dice una data al telefono.
 */
export function dataParlata(iso: string | Date | null | undefined, oggi: Date = new Date()): string | null {
  if (!iso) return null
  const d = iso instanceof Date ? iso : new Date(iso)
  if (Number.isNaN(d.getTime())) return null
  const anno = (x: Date) => new Intl.DateTimeFormat('it-IT', { timeZone: FUSO, year: 'numeric' }).format(x)
  const conAnno = anno(d) !== anno(oggi)
  return new Intl.DateTimeFormat('it-IT', {
    timeZone: FUSO,
    day: 'numeric',
    month: 'long',
    ...(conAnno ? { year: 'numeric' } : {}),
  }).format(d)
}

const MASSIMA_LUNGHEZZA_TITOLO = 80

export function articoliParlati(righe: Array<{ titolo: string | null; quantita: number | null }>): string[] {
  return righe
    .filter((r) => r.titolo)
    .map((r) => {
      const titolo =
        r.titolo!.length > MASSIMA_LUNGHEZZA_TITOLO
          ? `${r.titolo!.slice(0, MASSIMA_LUNGHEZZA_TITOLO).trimEnd()}…`
          : r.titolo!
      const q = r.quantita ?? 1
      return `${titolo} (${q} ${q === 1 ? 'pezzo' : 'pezzi'})`
    })
}

/** Corriere come si pronuncia: le varianti di grafia in archivio ("brt", "BRT") diventano una. */
export function corriereParlato(carrier: string | null): string | null {
  const c = carrier?.trim()
  if (!c) return null
  return c.length <= 4 ? c.toUpperCase() : c
}
