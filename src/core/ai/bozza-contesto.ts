import type { Config } from '../../config.js'
import type { Db } from '../../db/index.js'
import { costoProdottoPim } from '../../connectors/pim/assistenza.js'

/**
 * I dati dell'ordine che l'agente delle bozze ha davanti (elenco della
 * specifica). `formattaContestoOrdine` è pura e si testa; `caricaDatiOrdine`
 * è l'unica parte che legge dal database.
 *
 * Niente dati personali del cliente qui: nessun indirizzo, telefono o
 * nome. Gli eventi del corriere sono ridotti a data, stato e luogo
 * generico: i blocchi del corriere contengono nomi e indirizzi, e la
 * specifica vieta di ricopiarli (e la regola 8 di tenerli fuori dai prompt).
 */

export interface DatiOrdine {
  canale: string
  operatore: string | null
  fba: boolean
  numero: string | null
  data_ordine: Date | null
  stato_pagamento: string | null
  stato_evasione: string | null
  corriere: string | null
  tracking: string | null
  tracking_url: string | null
  spedizione_stato: string | null
  spedizione_data: Date | null
  consegna_prevista: Date | null
  giacenza: unknown
  eventi: unknown
  reso_richiesto_at: Date | null
  reso_corriere: string | null
  reso_tracking: string | null
  rimborso_totale: string | null
  rimborso_emesso_at: Date | null
  reclamo_az_importo: string | null
  reclamo_az_ricevuto_at: Date | null
  valuta: string | null
  righe: { sku: string | null; titolo: string | null; quantita: number }[]
  etichette_reso: { tipo: string; stato: string }[]
  rientrato_logistica: boolean
  foto_ricevute: number
  stato_ticket: string
  ticket_collegato: boolean
  tag: string[]
  costo_prodotto: { sku: string; costo: number; valuta: string } | null
}

const dataIt = (d: Date | null): string | null =>
  d ? new Date(d).toISOString().slice(0, 10) : null

/** Riduce gli eventi del corriere a "data stato (luogo)" senza testo libero. */
function eventiRidotti(eventi: unknown): string | null {
  if (!Array.isArray(eventi) || eventi.length === 0) return null
  return eventi
    .slice(0, 4)
    .map((e) => {
      if (!e || typeof e !== 'object') return null
      const r = e as Record<string, unknown>
      const quando = typeof r.data === 'string' ? r.data : ''
      const cosa = typeof r.evento === 'string' ? r.evento : typeof r.descrizione === 'string' ? r.descrizione : ''
      return `${quando} ${cosa}`.trim() || null
    })
    .filter(Boolean)
    .join('; ')
}

export function formattaContestoOrdine(d: DatiOrdine | null, oggi = new Date()): string {
  if (!d) return 'Nessun ordine collegato a questa conversazione: non puoi dire nulla su spedizione, reso o rimborso. Se serve, chiedi il riferimento dell\'ordine.'
  const righe: (string | null)[] = []
  const giorni = (da: Date | null) => (da ? Math.floor((oggi.getTime() - new Date(da).getTime()) / 86_400_000) : null)

  righe.push(`Canale: ${d.canale}${d.operatore ? ` (${d.operatore})` : ''}${d.fba ? ', spedito da Amazon (FBA): noi non possiamo agire sul reso' : ''}`)
  if (d.numero) righe.push(`Numero ordine: ${d.numero}`)
  if (d.data_ordine) {
    righe.push(`Data ordine: ${dataIt(d.data_ordine)} (${giorni(d.data_ordine)} giorni fa)`)
  }
  if (d.stato_pagamento) righe.push(`Pagamento: ${d.stato_pagamento}`)
  righe.push(`Stato evasione: ${d.stato_evasione ?? 'non spedito / sconosciuto'}`)
  if (d.corriere || d.tracking) righe.push(`Corriere: ${d.corriere ?? 'non indicato'}, numero spedizione: ${d.tracking ?? 'non presente'}`)
  if (d.tracking_url) righe.push(`Link di tracciamento: ${d.tracking_url}`)
  if (d.spedizione_stato) {
    righe.push(
      `Stato spedizione: ${d.spedizione_stato}${d.spedizione_stato === 'consegnato' && d.spedizione_data ? ` il ${dataIt(d.spedizione_data)} (${giorni(d.spedizione_data)} giorni fa: il reso entro 14 giorni conta da qui)` : ''}`,
    )
  }
  if (d.consegna_prevista) righe.push(`Consegna prevista dal corriere: ${dataIt(d.consegna_prevista)} (non comunicarla al cliente come data precisa)`)
  const ev = eventiRidotti(d.eventi)
  if (ev) righe.push(`Ultimi eventi del corriere: ${ev}`)
  if (d.giacenza) righe.push(`Giacenza presente: ${JSON.stringify(d.giacenza).slice(0, 300)}`)

  righe.push(
    d.reso_richiesto_at
      ? `Reso: richiesto il ${dataIt(d.reso_richiesto_at)}${d.reso_corriere ? `, corriere ${d.reso_corriere}` : ''}${d.reso_tracking ? `, tracking reso ${d.reso_tracking}` : ', tracking reso non presente'}`
      : 'Reso: nessuna richiesta di reso risulta.',
  )
  righe.push(`Rientro in magazzino: ${d.rientrato_logistica ? 'SÌ, il pacco è rientrato' : 'non risulta rientrato'}`)
  righe.push(
    d.rimborso_totale
      ? `Rimborso già emesso: ${d.rimborso_totale} ${d.valuta ?? 'EUR'} il ${dataIt(d.rimborso_emesso_at)}`
      : 'Rimborso già emesso: no',
  )
  if (d.reclamo_az_importo) righe.push(`Reclamo A-Z ricevuto il ${dataIt(d.reclamo_az_ricevuto_at)}, importo ${d.reclamo_az_importo}`)
  righe.push(
    d.etichette_reso.length
      ? `Etichetta di reso BRT già creata per questo ticket: ${d.etichette_reso.map((e) => `${e.tipo} (${e.stato})`).join(', ')}`
      : 'Etichetta di reso BRT per questo ticket: nessuna',
  )
  righe.push(`Foto già ricevute dal cliente in questo ticket: ${d.foto_ricevute}`)
  if (d.righe.length) {
    righe.push(`Prodotti: ${d.righe.map((r) => `${r.quantita} x ${r.titolo ?? r.sku ?? 'articolo'}${r.sku ? ` (${r.sku})` : ''}`).join('; ')}`)
  }
  righe.push(`Stato del ticket: ${d.stato_ticket}${d.ticket_collegato ? ' (ticket collegato verso corriere o assistenza, non verso il cliente)' : ''}`)
  if (d.tag.length) righe.push(`Tag del ticket (solo indicativi, la classificazione va fatta dal testo): ${d.tag.join(', ')}`)
  if (d.costo_prodotto) {
    righe.push(
      `SOLO PER LA NOTA ALL'OPERATORE, mai nella bozza: costo di acquisto del prodotto ${d.costo_prodotto.sku}: ${d.costo_prodotto.costo.toFixed(2)} ${d.costo_prodotto.valuta} (dal PIM; è il costo di acquisto, non il landed completo)`,
    )
  } else {
    righe.push('Costo del prodotto: non disponibile, se serve per un rimborso senza reso scrivilo nella nota come dato mancante.')
  }
  return righe.filter(Boolean).join('\n')
}

export async function caricaDatiOrdine(db: Db, config: Config, threadId: string): Promise<DatiOrdine | null> {
  const [o] = await db<
    {
      order_id: string | null
      channel: string
      operator: string | null
      fba: boolean
      numero: string | null
      placed_at: Date | null
      financial_status: string | null
      fulfillment_status: string | null
      carrier: string | null
      tracking_number: string | null
      tracking_url: string | null
      spedizione_stato: string | null
      spedizione_data: Date | null
      tracking_consegna_prevista: Date | null
      tracking_giacenza: unknown
      tracking_eventi: unknown
      reso_richiesto_at: Date | null
      reso_carrier: string | null
      reso_tracking_number: string | null
      rimborso_totale: string | null
      rimborso_emesso_at: Date | null
      reclamo_az_importo: string | null
      reclamo_az_ricevuto_at: Date | null
      currency: string | null
      state: string
      linked_thread_id: string | null
      tags: string[]
    }[]
  >`
    select o.id as order_id, o.channel, o.operator,
           coalesce(o.raw->'tags' ? 'FBA' or o.raw->>'tags' ~ '(^|,)[[:space:]]*FBA[[:space:]]*(,|$)', false) as fba,
           coalesce(o.shopify_name, o.external_order_id) as numero,
           o.placed_at, o.financial_status, o.fulfillment_status, o.carrier,
           o.tracking_number, o.tracking_url, o.spedizione_stato, o.spedizione_data,
           o.tracking_consegna_prevista, o.tracking_giacenza, o.tracking_eventi,
           o.reso_richiesto_at, o.reso_carrier, o.reso_tracking_number,
           o.rimborso_totale::text, o.rimborso_emesso_at,
           o.reclamo_az_importo::text, o.reclamo_az_ricevuto_at, o.currency,
           t.state, t.linked_thread_id, t.tags
    from thread t
    left join "order" o on o.id = t.order_id
    where t.id = ${threadId}
  `
  if (!o) return null

  const [foto] = await db<{ n: string }[]>`
    select count(*)::text as n
    from attachment a join message m on m.id = a.message_id
    where m.thread_id = ${threadId} and a.direzione = 'in' and a.mime like 'image/%'
  `
  const base = {
    foto_ricevute: Number(foto?.n ?? 0),
    stato_ticket: o.state,
    ticket_collegato: !!o.linked_thread_id,
    tag: o.tags ?? [],
  }
  if (!o.order_id) return null

  const righe = await db<{ sku: string | null; titolo: string | null; quantita: number }[]>`
    select sku, titolo, quantita from order_line where order_id = ${o.order_id} order by created_at limit 10
  `
  const etichette = await db<{ tipo: string; stato: string }[]>`
    select tipo, stato from etichetta_reso where thread_id = ${threadId}
  `
  // Rientro: il tag lo scrive magazzino/rientri.ts, l'unico che lo sa.
  const rientrato = (o.tags ?? []).includes('pacco-rientrato-logistica')
  const sku = righe.find((r) => r.sku)?.sku
  const costo = sku ? await costoProdottoPim(config, sku) : null

  return {
    canale: o.channel,
    operatore: o.operator,
    fba: o.fba,
    numero: o.numero,
    data_ordine: o.placed_at,
    stato_pagamento: o.financial_status,
    stato_evasione: o.fulfillment_status,
    corriere: o.carrier,
    tracking: o.tracking_number,
    tracking_url: o.tracking_url,
    spedizione_stato: o.spedizione_stato,
    spedizione_data: o.spedizione_data,
    consegna_prevista: o.tracking_consegna_prevista,
    giacenza: o.tracking_giacenza,
    eventi: o.tracking_eventi,
    reso_richiesto_at: o.reso_richiesto_at,
    reso_corriere: o.reso_carrier,
    reso_tracking: o.reso_tracking_number,
    rimborso_totale: o.rimborso_totale,
    rimborso_emesso_at: o.rimborso_emesso_at,
    reclamo_az_importo: o.reclamo_az_importo,
    reclamo_az_ricevuto_at: o.reclamo_az_ricevuto_at,
    valuta: o.currency,
    righe,
    etichette_reso: etichette,
    rientrato_logistica: rientrato,
    costo_prodotto: costo,
    ...base,
  }
}
