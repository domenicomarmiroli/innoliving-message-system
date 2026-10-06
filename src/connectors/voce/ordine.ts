import type { Db } from '../../db/index.js'
import { etichettaCanale } from '../../core/voce/verifica.js'
import {
  articoliParlati,
  cifrePerCifra,
  corriereParlato,
  dataParlata,
  statoOrdine,
  type StatoOrdine,
} from '../../core/voce/stato.js'

/**
 * Lo stato dell'ordine verificato, in forma da dire al telefono.
 *
 * Solo campi che l'agente può usare senza interpretare. Niente indirizzo,
 * niente email, niente totale dell'ordine: non servono a rispondere a
 * "dov'è il mio ordine" e al telefono non si leggono dati personali.
 */

export interface StatoParlato {
  stato: StatoOrdine
  spedizione_parziale: boolean
  canale: string
  data_ordine: string | null
  data_spedizione: string | null
  /** Dalla pagina BRT, solo per le spedizioni non ancora consegnate. */
  consegna_prevista: string | null
  corriere: string | null
  tracking_disponibile: boolean
  numero_tracking: string | null
  /**
   * Ordine Amazon FBA: spedito da Amazon dal suo magazzino. Tracking e
   * assistenza su quella consegna li gestisce Amazon, non noi: l'agente
   * indirizza il cliente lì invece di aprire un ticket che non possiamo
   * risolvere.
   */
  gestito_da_amazon: boolean
  /**
   * La pratica già aperta su quest'ordine (qualunque canale), se c'è:
   * l'agente non deve presentare come nuova una richiesta già in carico.
   */
  ticket_in_corso: {
    numero: string
    /** Da dire così: le cifre separate. */
    numero_da_dettare: string
    stato: 'aperto' | 'in_attesa'
    aperto_il: string | null
  } | null
  articoli: string[]
  reso_richiesto_il: string | null
  rimborso: { importo: string; data: string | null } | null
}

interface Riga {
  channel: string
  operator: string | null
  placed_at: Date | null
  financial_status: string | null
  fulfillment_status: string | null
  carrier: string | null
  tracking_number: string | null
  reso_richiesto_at: Date | null
  rimborso_totale: string | null
  rimborso_emesso_at: Date | null
  currency: string | null
  annullato_il: string | null
  spedito_il: string | null
  spedizione_stato: string | null
  fba: boolean
  tracking_consegna_prevista: string | null
}

export function importoParlato(importo: string | number, valuta: string | null): string {
  const n = typeof importo === 'number' ? importo : Number(importo)
  const cifra = new Intl.NumberFormat('it-IT', { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(n)
  return !valuta || valuta.toUpperCase() === 'EUR' ? `${cifra} euro` : `${cifra} ${valuta.toUpperCase()}`
}

export async function statoDellOrdine(db: Db, orderId: string): Promise<StatoParlato | null> {
  const [o] = await db<Riga[]>`
    select channel, operator, placed_at, financial_status, fulfillment_status,
           carrier, tracking_number, reso_richiesto_at,
           rimborso_totale::text as rimborso_totale, rimborso_emesso_at, currency,
           coalesce(raw->>'cancelledAt', raw->>'cancelled_at') as annullato_il,
           coalesce(spedizione_data::text, raw->'fulfillments'->0->>'createdAt', raw->'fulfillments'->0->>'created_at') as spedito_il,
           spedizione_stato,
           tracking_consegna_prevista::text as tracking_consegna_prevista,
           -- I tag arrivano come array (GraphQL) o come stringa separata da
           -- virgole (webhook REST): si accettano entrambe le forme.
           coalesce(raw->'tags' ? 'FBA' or raw->>'tags' ~ '(^|,)[[:space:]]*FBA[[:space:]]*(,|$)', false) as fba
    from "order" where id = ${orderId}
  `
  if (!o) return null

  const [pratica] = await db<{ numero: string; state: string; created_at: Date }[]>`
    select numero::text as numero, state, created_at from thread
    where order_id = ${orderId} and state <> 'closed' and linked_thread_id is null
    order by last_inbound_at desc nulls last, created_at desc
    limit 1
  `

  const righe = await db<{ titolo: string | null; quantita: number | null }[]>`
    select titolo, quantita from order_line where order_id = ${orderId} order by titolo
  `

  const { stato, spedizione_parziale } = statoOrdine({
    financial_status: o.financial_status,
    fulfillment_status: o.fulfillment_status,
    annullato_il: o.annullato_il,
    placed_at: o.placed_at,
    spedizione_stato: o.spedizione_stato,
  })
  const spedito = stato === 'spedito' || stato === 'in_consegna' || stato === 'consegnato' || stato === 'problema_consegna'

  return {
    stato,
    spedizione_parziale,
    canale: etichettaCanale(o.channel, o.operator),
    data_ordine: dataParlata(o.placed_at),
    data_spedizione: spedito ? dataParlata(o.spedito_il) : null,
    consegna_prevista: stato === 'spedito' || stato === 'in_consegna' ? dataParlata(o.tracking_consegna_prevista) : null,
    corriere: corriereParlato(o.carrier),
    tracking_disponibile: !!o.tracking_number,
    numero_tracking: o.tracking_number,
    gestito_da_amazon: o.channel === 'amazon' && o.fba,
    ticket_in_corso: pratica
      ? {
          numero: pratica.numero,
          numero_da_dettare: cifrePerCifra(pratica.numero),
          stato: pratica.state.startsWith('pending') ? 'in_attesa' : 'aperto',
          aperto_il: dataParlata(pratica.created_at),
        }
      : null,
    articoli: articoliParlati(righe),
    reso_richiesto_il: dataParlata(o.reso_richiesto_at),
    rimborso:
      o.rimborso_totale !== null
        ? { importo: importoParlato(o.rimborso_totale, o.currency), data: dataParlata(o.rimborso_emesso_at) }
        : null,
  }
}
