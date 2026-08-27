/**
 * Normalizzazione degli ordini Shopify verso il modello canonico.
 *
 * Il connettore riceve gli ordini in due forme diverse e deve trattarle
 * entrambe:
 *  - i WEBHOOK arrivano in forma REST, con i campi in snake_case
 *    (name, source_name, note_attributes, line_items);
 *  - il BACKFILL arriva dalla GraphQL Admin API, in camelCase
 *    (sourceName, customAttributes, lineItems).
 * Due adattatori, un solo normalizzatore: la logica di riconoscimento del
 * canale sta scritta una volta sola ed è testabile senza rete.
 *
 * Le regole di riconoscimento sono ricavate dai dati reali dello store,
 * non da ipotesi. Vedi test/fixtures/shopify/ per gli esemplari.
 */

export type Canale = 'amazon' | 'mirakl' | 'tiktok' | 'shopify'

/**
 * Stessa forma sia dal webhook REST (snake_case: address1, address2, city,
 * province, zip, country, phone, name) sia dalla GraphQL Admin API
 * (identici tranne countryCodeV2/provinceCode che non servono qui): un
 * solo estrattore basta per entrambi gli adattatori.
 */
export interface IndirizzoCanonico {
  nome: string | null
  telefono: string | null
  indirizzo1: string | null
  indirizzo2: string | null
  citta: string | null
  provincia: string | null
  cap: string | null
  paese: string | null
}

export interface RigaCanonica {
  sku: string | null
  titolo: string | null
  quantita: number
  prezzo: number | null
  image_url: string | null
  raw: unknown
}

export interface OrdineCanonico {
  channel: Canale
  external_order_id: string
  shopify_gid: string | null
  shopify_name: string | null
  operator: string | null
  buyer_alias: string | null
  placed_at: string | null
  financial_status: string | null
  fulfillment_status: string | null
  tracking_number: string | null
  tracking_url: string | null
  carrier: string | null
  total: number | null
  currency: string | null
  /** Ordine di servizio (ricambio, garanzia): non è una vendita. */
  is_service_order: boolean
  shipping_address: IndirizzoCanonico | null
  billing_address: IndirizzoCanonico | null
  righe: RigaCanonica[]
  raw: unknown
}

/** Forma intermedia comune ai due adattatori. */
interface Grezzo {
  gid: string | null
  name: string | null
  source_name: string | null
  source_identifier: string | null
  tags: string[]
  attributi: Record<string, string>
  created_at: string | null
  financial_status: string | null
  fulfillment_status: string | null
  total: number | null
  currency: string | null
  tracking_number: string | null
  tracking_url: string | null
  carrier: string | null
  shipping_address: IndirizzoCanonico | null
  billing_address: IndirizzoCanonico | null
  righe: RigaCanonica[]
  raw: unknown
}

const num = (v: unknown): number | null => {
  if (v === null || v === undefined || v === '') return null
  const n = typeof v === 'string' ? Number(v) : typeof v === 'number' ? v : NaN
  return Number.isFinite(n) ? n : null
}

const str = (v: unknown): string | null =>
  typeof v === 'string' && v.trim() !== '' ? v.trim() : null

function estraiIndirizzo(a: Record<string, unknown> | null | undefined): IndirizzoCanonico | null {
  if (!a) return null
  return {
    nome: str(a['name']),
    telefono: str(a['phone']),
    indirizzo1: str(a['address1']),
    indirizzo2: str(a['address2']),
    citta: str(a['city']),
    provincia: str(a['province']),
    cap: str(a['zip']),
    paese: str(a['country']),
  }
}

/** Tag di servizio: questi ordini non sono vendite e non entrano nel fatturato. */
export const TAG_SERVIZIO = ['RICAMBIO', 'GARANZIA', 'SOSTITUZIONE']

function isServizio(tags: string[]): boolean {
  const up = tags.map((t) => t.toUpperCase())
  return TAG_SERVIZIO.some((t) => up.includes(t))
}

/* ------------------------------------------------------------------ */
/* Riconoscimento del canale                                           */
/* ------------------------------------------------------------------ */

/**
 * Determina canale e identificativo esterno.
 *
 * L'ordine dei controlli conta: Amazon prima di tutto perché si riconosce
 * dal prefisso del nome, Mirakl dal tag, TikTok dalla sorgente. Il sito è
 * il caso residuo.
 */
export function riconosciCanale(g: Grezzo): {
  channel: Canale
  external_order_id: string
  operator: string | null
  buyer_alias: string | null
} {
  const tagsUp = g.tags.map((t) => t.toUpperCase())
  const name = g.name ?? ''

  // --- Amazon: l'ID sta dentro il nome dell'ordine, es. AMZ304-0904527-7250707
  if (name.toUpperCase().startsWith('AMZ') || tagsUp.includes('AMAZON-IMPORT')) {
    const match = name.match(/\d{3}-\d{7}-\d{7}/)
    return {
      channel: 'amazon',
      external_order_id: match ? match[0] : name.replace(/^AMZ/i, ''),
      operator: null,
      buyer_alias: g.attributi['Customer email'] ?? null,
    }
  }

  // --- Mirakl: tag "Mirakl", operatore in source_name, id in source_identifier
  if (tagsUp.includes('MIRAKL')) {
    return {
      channel: 'mirakl',
      external_order_id:
        g.source_identifier ?? g.attributi['Order_id'] ?? name,
      operator: g.source_name ?? g.attributi['Tenant_id'] ?? null,
      // Il connettore Mirakl→Shopify porta l'alias dell'acquirente: è la
      // chiave che collega i messaggi all'ordine.
      buyer_alias: g.attributi['Customer email'] ?? null,
    }
  }

  // --- TikTok Shop
  if ((g.source_name ?? '').toLowerCase() === 'tiktok' || tagsUp.includes('TIKTOK SHOP')) {
    return {
      channel: 'tiktok',
      external_order_id:
        g.attributi['TikTok Order Number'] ?? name.replace(/^TTOK/i, ''),
      operator: null,
      buyer_alias: null,
    }
  }

  // --- Sito: caso residuo. source_name è "channel:<numero>" o "web".
  return { channel: 'shopify', external_order_id: name, operator: null, buyer_alias: null }
}

function componi(g: Grezzo): OrdineCanonico {
  const { channel, external_order_id, operator, buyer_alias } = riconosciCanale(g)
  return {
    channel,
    external_order_id,
    shopify_gid: g.gid,
    shopify_name: g.name,
    operator,
    buyer_alias,
    placed_at: g.created_at,
    financial_status: g.financial_status,
    fulfillment_status: g.fulfillment_status,
    tracking_number: g.tracking_number,
    tracking_url: g.tracking_url,
    carrier: g.carrier,
    total: g.total,
    currency: g.currency,
    is_service_order: isServizio(g.tags),
    shipping_address: g.shipping_address,
    billing_address: g.billing_address,
    righe: g.righe,
    raw: g.raw,
  }
}

/* ------------------------------------------------------------------ */
/* Adattatore WEBHOOK (forma REST, snake_case)                         */
/* ------------------------------------------------------------------ */

export function daWebhook(payload: Record<string, unknown>): OrdineCanonico {
  const attributi: Record<string, string> = {}
  for (const a of (payload['note_attributes'] as { name?: string; value?: string }[]) ?? []) {
    if (a?.name) attributi[a.name] = a.value ?? ''
  }

  const fulfillments = (payload['fulfillments'] as Record<string, unknown>[]) ?? []
  const primo = fulfillments[0] ?? {}

  const righe: RigaCanonica[] = (
    (payload['line_items'] as Record<string, unknown>[]) ?? []
  ).map((l) => ({
    sku: str(l['sku']),
    titolo: str(l['title']),
    quantita: num(l['quantity']) ?? 1,
    prezzo: num(l['price']),
    image_url: null, // il webhook non porta le immagini: le riempie il backfill
    raw: l,
  }))

  const tagsRaw = payload['tags']
  const tags =
    typeof tagsRaw === 'string'
      ? tagsRaw.split(',').map((t) => t.trim()).filter(Boolean)
      : Array.isArray(tagsRaw)
        ? (tagsRaw as string[])
        : []

  return componi({
    gid: payload['admin_graphql_api_id'] ? String(payload['admin_graphql_api_id']) : null,
    name: str(payload['name']),
    source_name: str(payload['source_name']),
    source_identifier: str(payload['source_identifier']),
    tags,
    attributi,
    created_at: str(payload['created_at']),
    financial_status: str(payload['financial_status']),
    fulfillment_status: str(payload['fulfillment_status']) ?? 'unfulfilled',
    total: num(payload['current_total_price'] ?? payload['total_price']),
    currency: str(payload['currency']),
    tracking_number: str(primo['tracking_number']),
    tracking_url: str(primo['tracking_url']),
    carrier: str(primo['tracking_company']),
    shipping_address: estraiIndirizzo(payload['shipping_address'] as Record<string, unknown> | null),
    billing_address: estraiIndirizzo(payload['billing_address'] as Record<string, unknown> | null),
    righe,
    raw: payload,
  })
}

/* ------------------------------------------------------------------ */
/* Adattatore GRAPHQL (backfill, camelCase)                            */
/* ------------------------------------------------------------------ */

export function daGraphQL(node: Record<string, any>): OrdineCanonico {
  const attributi: Record<string, string> = {}
  for (const a of node.customAttributes ?? []) {
    if (a?.key) attributi[a.key] = a.value ?? ''
  }

  const tracking = node.fulfillments?.[0]?.trackingInfo?.[0] ?? {}

  const righe: RigaCanonica[] = (node.lineItems?.nodes ?? []).map((l: any) => ({
    sku: str(l.sku),
    titolo: str(l.title),
    quantita: num(l.quantity) ?? 1,
    prezzo: num(l.originalUnitPriceSet?.shopMoney?.amount),
    image_url: str(l.image?.url),
    raw: l,
  }))

  return componi({
    gid: str(node.id),
    name: str(node.name),
    source_name: str(node.sourceName),
    source_identifier: str(node.sourceIdentifier),
    tags: (node.tags ?? []) as string[],
    attributi,
    created_at: str(node.createdAt),
    financial_status: str(node.displayFinancialStatus)?.toLowerCase() ?? null,
    fulfillment_status: str(node.displayFulfillmentStatus)?.toLowerCase() ?? null,
    total: num(node.currentTotalPriceSet?.shopMoney?.amount),
    currency: str(node.currentTotalPriceSet?.shopMoney?.currencyCode),
    tracking_number: str(tracking.number),
    tracking_url: str(tracking.url),
    carrier: str(tracking.company),
    shipping_address: estraiIndirizzo(node.shippingAddress),
    billing_address: estraiIndirizzo(node.billingAddress),
    righe,
    raw: node,
  })
}
