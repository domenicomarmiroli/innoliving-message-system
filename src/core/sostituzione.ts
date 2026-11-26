import { z } from 'zod'

/**
 * Prodotto sostitutivo in garanzia: la parte pura (niente database, niente
 * rete), così si prova con i test.
 *
 * Il cliente ha rimandato il prodotto difettoso. Dal ticket l'operatore:
 *  - crea su Shopify l'ordine del sostitutivo a 0 euro, con lo SKU del
 *    negozio (il codice del prodotto più il suffisso del canale, es. "IS");
 *  - oppure, se il prodotto non è disponibile, un codice sconto monouso del
 *    valore dello scontrino, da usare sul negozio per un altro prodotto.
 */

export interface ConfigSostituzione {
  suffisso_sku: string
  tag_ordine: string
  prefisso_codice: string
  giorni_validita_codice: number
  invia_conferma_ordine: boolean
  invia_conferma_spedizione: boolean
  valuta: string
}

export const CONFIG_PREDEFINITA: ConfigSostituzione = {
  suffisso_sku: 'IS',
  tag_ordine: 'sostituzione-garanzia',
  prefisso_codice: 'GARANZIA',
  giorni_validita_codice: 90,
  invia_conferma_ordine: false,
  invia_conferma_spedizione: true,
  valuta: 'EUR',
}

export function leggiConfigSostituzione(valore: unknown): ConfigSostituzione {
  const v = (valore && typeof valore === 'object' ? valore : {}) as Partial<ConfigSostituzione>
  return { ...CONFIG_PREDEFINITA, ...v }
}

/** "inn-732" → "INN-732IS"; un codice che ha già il suffisso resta com'è. */
export function skuNegozio(codice: string, suffisso: string): string {
  const c = codice.trim().toUpperCase().replace(/\s+/g, '')
  const s = suffisso.trim().toUpperCase()
  if (!s || c.endsWith(s)) return c
  return c + s
}

/**
 * Il codice del prodotto dai messaggi del ticket: prima i dati strutturati
 * del portale garanzie (message.raw.garanzia), poi la riga "Codice: ..." del
 * testo, poi l'oggetto ("... INN-732").
 */
export function codiceProdottoDaTicket(
  messaggi: { raw: Record<string, unknown> | null; testo: string | null }[],
  oggetto: string | null,
): string | null {
  for (const m of messaggi) {
    const g = m.raw?.['garanzia'] as Record<string, unknown> | undefined
    for (const campo of ['codice_modello', 'codice']) {
      const v = g?.[campo]
      if (typeof v === 'string' && v.trim()) return v.trim().toUpperCase()
    }
  }
  for (const m of messaggi) {
    const r = m.testo?.match(/^\s*Codice\s*:\s*([A-Za-z0-9][A-Za-z0-9._-]{1,40})\s*$/im)
    if (r) return r[1]!.toUpperCase()
  }
  const o = oggetto?.match(/\b([A-Z]{2,5}-[A-Z0-9]{2,}[A-Z0-9-]*)\b/)
  return o ? o[1]! : null
}

/** Il valore dello scontrino dai dati del portale, se è riuscito a leggerlo. */
export function valoreDaGaranzia(g: { valore_prodotto?: number | null } | null | undefined): number | null {
  const v = g?.valore_prodotto
  return typeof v === 'number' && Number.isFinite(v) && v > 0 ? Math.round(v * 100) / 100 : null
}

export interface VarianteNegozio {
  variant_gid: string
  sku: string
  titolo: string
  prezzo: string
  disponibili: number | null
  vendibile: boolean
  stato_prodotto: string
}

export type SceltaVariante =
  | { esito: 'trovata'; variante: VarianteNegozio; disponibile: boolean }
  | { esito: 'non_trovata' }
  | { esito: 'ambigua'; varianti: VarianteNegozio[] }

/** Disponibile = in vendita, prodotto attivo e almeno un pezzo (se Shopify conta i pezzi). */
export function varianteDisponibile(v: VarianteNegozio): boolean {
  return v.vendibile && v.stato_prodotto === 'ACTIVE' && (v.disponibili === null || v.disponibili > 0)
}

/** Fra le varianti trovate, quella con lo SKU esatto. Mai indovinare: zero o più → lo dice. */
export function scegliVariante(varianti: VarianteNegozio[], sku: string): SceltaVariante {
  const esatte = varianti.filter((v) => v.sku.trim().toUpperCase() === sku.toUpperCase())
  if (esatte.length === 1) {
    const variante = esatte[0]!
    return { esito: 'trovata', variante, disponibile: varianteDisponibile(variante) }
  }
  if (esatte.length > 1) return { esito: 'ambigua', varianti: esatte }
  return { esito: 'non_trovata' }
}

export const schemaIndirizzo = z.object({
  nome: z.string().trim().min(1).max(100),
  cognome: z.string().trim().min(1).max(100),
  presso: z.string().trim().max(150).nullable().optional(),
  indirizzo: z.string().trim().min(3).max(200),
  indirizzo2: z.string().trim().max(200).nullable().optional(),
  cap: z.string().trim().min(3).max(12),
  citta: z.string().trim().min(1).max(100),
  provincia: z.string().trim().max(5).nullable().optional(),
  paese: z.string().trim().length(2).default('IT'),
  telefono: z.string().trim().max(40).nullable().optional(),
})
export type Indirizzo = z.infer<typeof schemaIndirizzo>

/**
 * L'indirizzo che il portale garanzie chiede al cliente all'apertura della
 * richiesta (idea di Domenico, 2026-11-25): così al sostitutivo c'è già.
 * In entrata è tollerante (un campo storto non deve far perdere il ticket);
 * si controlla davvero solo quando si crea l'ordine.
 */
const campo = (max: number) => z.string().trim().max(max).nullable().optional()
export const schemaIndirizzoPortale = z.object({
  nome: campo(100),
  cognome: campo(100),
  presso: campo(150),
  indirizzo: campo(200),
  indirizzo2: campo(200),
  cap: campo(12),
  citta: campo(100),
  provincia: campo(5),
  paese: campo(2),
  telefono: campo(40),
})
export type IndirizzoPortale = z.infer<typeof schemaIndirizzoPortale>

/**
 * Ticket nati prima del portale nuovo: solo l'intestatario e un "indirizzo di
 * ritiro" scritto a mano ("via delle rose 12/f san pietro in casale 40018 (BO)").
 * Si propone quello che si riconosce con sicurezza: nome e cognome, CAP,
 * provincia; il resto del testo va in "indirizzo" e l'operatore lo sistema.
 */
export function indirizzoDaRitiro(
  intestatario: string | null | undefined,
  ritiro: string | null | undefined,
  telefono: string | null | undefined,
): IndirizzoPortale | null {
  const nomeIntero = intestatario?.trim().replace(/\s+/g, ' ') ?? ''
  const testo = ritiro?.trim().replace(/\s+/g, ' ') ?? ''
  if (!nomeIntero && !testo) return null
  const parole = nomeIntero ? nomeIntero.split(' ') : []
  const cognome = parole.length > 1 ? parole.pop()! : null
  const nome = parole.length ? parole.join(' ') : null
  const cap = testo.match(/\b(\d{5})\b/)?.[1] ?? null
  const provincia = (testo.match(/\(([A-Za-z]{2})\)/)?.[1] ?? testo.match(/\s([A-Z]{2})\s*,/)?.[1] ?? testo.match(/\s([A-Z]{2})$/)?.[1] ?? null)?.toUpperCase() ?? null
  return { nome, cognome, presso: null, indirizzo: testo || null, indirizzo2: null, cap, citta: null, provincia, paese: 'IT', telefono: telefono?.trim() || null }
}

/** L'indirizzo del portale, se è completo; altrimenti null (lo completa l'operatore). */
export function indirizzoCompleto(i: IndirizzoPortale | null | undefined): Indirizzo | null {
  if (!i) return null
  const r = schemaIndirizzo.safeParse({ ...i, paese: i.paese || 'IT' })
  return r.success ? r.data : null
}

export function indirizzoShopify(i: Indirizzo): Record<string, string> {
  const a: Record<string, string> = {
    firstName: i.nome,
    lastName: i.cognome,
    address1: i.indirizzo,
    zip: i.cap,
    city: i.citta,
    countryCode: i.paese.toUpperCase(),
  }
  if (i.indirizzo2) a['address2'] = i.indirizzo2
  if (i.presso) a['company'] = i.presso
  if (i.provincia) a['provinceCode'] = i.provincia.toUpperCase()
  if (i.telefono) a['phone'] = i.telefono
  return a
}

export interface DatiOrdine {
  numero_ticket: string
  variant_gid: string
  email: string | null
  indirizzo: Indirizzo
  conf: ConfigSostituzione
}

/** Input di orderCreate: una riga a 0 euro, già pagato, scala la giacenza. */
export function inputOrdine(d: DatiOrdine): { order: Record<string, unknown>; options: Record<string, unknown> } {
  const indirizzo = indirizzoShopify(d.indirizzo)
  const order: Record<string, unknown> = {
    currency: d.conf.valuta,
    lineItems: [
      {
        variantId: d.variant_gid,
        quantity: 1,
        priceSet: { shopMoney: { amount: '0.00', currencyCode: d.conf.valuta } },
        // Senza questo orderCreate segna la riga "Shipping not required" e il
        // magazzino non la spedisce mai (ordine INSH19984, 2026-11-26).
        requiresShipping: true,
      },
    ],
    // Spedizione a 0 euro, così l'ordine ha un metodo di spedizione come quelli del sito.
    shippingLines: [
      {
        title: 'Sostituzione in garanzia',
        code: d.conf.tag_ordine,
        priceSet: { shopMoney: { amount: '0.00', currencyCode: d.conf.valuta } },
      },
    ],
    shippingAddress: indirizzo,
    billingAddress: indirizzo,
    financialStatus: 'PAID',
    tags: [d.conf.tag_ordine, `ticket-${d.numero_ticket}`],
    note: `Sostituzione in garanzia, ticket ${d.numero_ticket}. Prodotto difettoso già rientrato.`,
    customAttributes: [{ key: 'ticket', value: d.numero_ticket }],
  }
  if (d.email) order['email'] = d.email
  if (d.indirizzo.telefono) order['phone'] = d.indirizzo.telefono
  return {
    order,
    options: {
      inventoryBehaviour: 'DECREMENT_OBEYING_POLICY',
      sendReceipt: d.conf.invia_conferma_ordine,
      sendFulfillmentReceipt: d.conf.invia_conferma_spedizione,
    },
  }
}

const ALFABETO = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789' // senza 0/O e 1/I: si dettano al telefono

/** "GARANZIA-16300-K7QM": si legge, si detta, non si indovina. */
export function codiceSconto(prefisso: string, numeroTicket: string, casuale: () => number = Math.random): string {
  let coda = ''
  for (let i = 0; i < 4; i++) coda += ALFABETO[Math.floor(casuale() * ALFABETO.length)]
  return `${prefisso.trim().toUpperCase()}-${numeroTicket}-${coda}`
}

export interface DatiSconto {
  codice: string
  numero_ticket: string
  importo: number
  inizio: Date
  conf: ConfigSostituzione
}

/** Input di discountCodeBasicCreate: importo fisso sull'ordine, una volta sola, con scadenza. */
export function inputSconto(d: DatiSconto): { basicCodeDiscount: Record<string, unknown>; scade_il: Date } {
  const scade_il = new Date(d.inizio.getTime() + d.conf.giorni_validita_codice * 86_400_000)
  return {
    scade_il,
    basicCodeDiscount: {
      title: `Garanzia ticket ${d.numero_ticket}`,
      code: d.codice,
      startsAt: d.inizio.toISOString(),
      endsAt: scade_il.toISOString(),
      context: { all: 'ALL' },
      customerGets: {
        value: { discountAmount: { amount: d.importo.toFixed(2), appliesOnEachItem: false } },
        items: { all: true },
      },
      usageLimit: 1,
      appliesOncePerCustomer: true,
      combinesWith: { orderDiscounts: false, productDiscounts: false, shippingDiscounts: true },
    },
  }
}
