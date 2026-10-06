import type { Db } from '../../db/index.js'
import { etichettaCanale } from '../../core/voce/verifica.js'
import {
  articoliParlati,
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
  corriere: string | null
  tracking_disponibile: boolean
  numero_tracking: string | null
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
           spedizione_stato
    from "order" where id = ${orderId}
  `
  if (!o) return null

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
  const spedito = stato === 'spedito' || stato === 'consegnato'

  return {
    stato,
    spedizione_parziale,
    canale: etichettaCanale(o.channel, o.operator),
    data_ordine: dataParlata(o.placed_at),
    data_spedizione: spedito ? dataParlata(o.spedito_il) : null,
    corriere: corriereParlato(o.carrier),
    tracking_disponibile: !!o.tracking_number,
    numero_tracking: o.tracking_number,
    articoli: articoliParlati(righe),
    reso_richiesto_il: dataParlata(o.reso_richiesto_at),
    rimborso:
      o.rimborso_totale !== null
        ? { importo: importoParlato(o.rimborso_totale, o.currency), data: dataParlata(o.rimborso_emesso_at) }
        : null,
  }
}
