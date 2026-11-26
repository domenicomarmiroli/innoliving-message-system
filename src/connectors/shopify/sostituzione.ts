import type { Config } from '../../config.js'
import type { Db } from '../../db/index.js'
import type { Logger } from '../../logger.js'
import {
  codiceProdottoDaTicket,
  codiceSconto,
  inputOrdine,
  indirizzoCompleto,
  inputSconto,
  leggiConfigSostituzione,
  scegliVariante,
  skuNegozio,
  varianteDisponibile,
  type ConfigSostituzione,
  type Indirizzo,
  type IndirizzoPortale,
  type SceltaVariante,
  type VarianteNegozio,
} from '../../core/sostituzione.js'
import { chiamaAdmin, ErroreShopify } from './admin.js'

/**
 * Prodotto sostitutivo in garanzia, dal ticket.
 *
 * Regola di Domenico (2026-11-25):
 *  - prodotto disponibile → ordine su Shopify a 0 euro; l'unica cosa che
 *    serve è l'indirizzo, che l'operatore chiede al cliente;
 *  - prodotto non disponibile → codice sconto monouso del valore dello
 *    scontrino, e quel valore arriva dal portale garanzie (letto dallo
 *    scontrino), non lo scrive l'operatore.
 * Un solo sostitutivo per ticket: la riga nasce 'in_corso' prima della
 * chiamata a Shopify, così un secondo clic non crea un secondo ordine.
 */

export class ErroreSostituzione extends Error {
  constructor(public readonly status: number, messaggio: string, public readonly codice?: string) {
    super(messaggio)
  }
}

interface RigaSostituzione {
  id: string
  tipo: 'ordine' | 'codice_sconto'
  stato: 'in_corso' | 'fatta' | 'errore'
  sku: string | null
  shopify_order_gid: string | null
  shopify_order_name: string | null
  codice_sconto: string | null
  importo: string | null
  scade_il: Date | null
  errore: string | null
  created_at: Date
}

interface Ticket {
  id: string
  numero: string
  subject: string | null
  valore_scontrino: string | null
  email: string | null
  nome: string | null
  telefono: string | null
  indirizzo_portale: IndirizzoPortale | null
}

async function configSostituzione(db: Db): Promise<ConfigSostituzione> {
  const [r] = await db<{ value: unknown }[]>`select value from app_config where key = 'sostituzione'`
  return leggiConfigSostituzione(r?.value)
}

async function leggiTicket(db: Db, threadId: string): Promise<{ t: Ticket; codice: string | null }> {
  const [t] = await db<Ticket[]>`
    select t.id, t.numero::text as numero, t.subject, t.valore_scontrino::text as valore_scontrino,
           (select m.raw->>'from' from message m where m.thread_id = t.id and m.direction = 'in'
             and m.author_kind = 'customer' order by m.sent_at limit 1) as email,
           (select coalesce(m.raw->>'nome', m.raw->'garanzia'->>'intestatario') from message m where m.thread_id = t.id
             and m.direction = 'in' and m.author_kind = 'customer' order by m.sent_at limit 1) as nome,
           (select m.raw->'garanzia'->>'telefono' from message m where m.thread_id = t.id
             and m.raw ? 'garanzia' order by m.sent_at limit 1) as telefono,
           (select m.raw->'garanzia'->'indirizzo_spedizione' from message m where m.thread_id = t.id
             and jsonb_typeof(m.raw->'garanzia'->'indirizzo_spedizione') = 'object'
             order by m.sent_at desc limit 1) as indirizzo_portale
    from thread t where t.id = ${threadId}
  `
  if (!t) throw new ErroreSostituzione(404, 'ticket non trovato')
  const messaggi = await db<{ raw: Record<string, unknown> | null; testo: string | null }[]>`
    select raw, body_text as testo from message
    where thread_id = ${threadId} and direction = 'in' and author_kind = 'customer'
    order by sent_at
  `
  return { t, codice: codiceProdottoDaTicket(messaggi, t.subject) }
}

const QUERY_VARIANTI = `
  query Varianti($q: String!) {
    productVariants(first: 20, query: $q) {
      nodes { id sku title price inventoryQuantity availableForSale product { title status } }
    }
  }`

interface NodoVariante {
  id: string
  sku: string | null
  title: string
  price: string
  inventoryQuantity: number | null
  availableForSale: boolean
  product: { title: string; status: string }
}

function daNodo(n: NodoVariante): VarianteNegozio {
  return {
    variant_gid: n.id,
    sku: n.sku ?? '',
    titolo: n.title === 'Default Title' ? n.product.title : `${n.product.title} (${n.title})`,
    prezzo: n.price,
    disponibili: n.inventoryQuantity,
    vendibile: n.availableForSale,
    stato_prodotto: n.product.status,
  }
}

export async function cercaVariante(config: Config, log: Logger, sku: string): Promise<SceltaVariante> {
  const d = await chiamaAdmin<{ productVariants: { nodes: NodoVariante[] } }>(config, log, QUERY_VARIANTI, {
    q: `sku:"${sku.replace(/"/g, '')}"`,
  })
  return scegliVariante(d.productVariants.nodes.map(daNodo), sku)
}

async function rigaEsistente(db: Db, threadId: string): Promise<RigaSostituzione | null> {
  const [r] = await db<RigaSostituzione[]>`
    select id, tipo, stato, sku, shopify_order_gid, shopify_order_name, codice_sconto, importo::text as importo,
           scade_il, errore, created_at
    from sostituzione where thread_id = ${threadId}
  `
  return r ?? null
}

export interface StatoSostituzione {
  numero_ticket: string
  codice_prodotto: string | null
  sku: string | null
  variante: VarianteNegozio | null
  esito_ricerca: 'trovata' | 'non_trovata' | 'ambigua' | 'senza_codice' | 'errore'
  disponibile: boolean
  varianti_ambigue: VarianteNegozio[]
  /** Dal portale garanzie: null se non l'ha letto dallo scontrino. */
  valore_scontrino: number | null
  cliente: { nome: string | null; email: string | null; telefono: string | null }
  /** Indirizzo dato dal cliente sul portale: per precompilare il modulo. */
  indirizzo_portale: IndirizzoPortale | null
  /** true se l'indirizzo del portale basta da solo per spedire. */
  indirizzo_completo: boolean
  sostituzione: RigaSostituzione | null
  azione: 'spedisci' | 'codice_sconto' | 'fatta' | 'da_verificare'
  avviso: string | null
}

/** Cosa mostrare all'operatore prima del clic: prodotto, disponibilità, azione possibile. */
export async function statoSostituzione(
  db: Db, config: Config, log: Logger, threadId: string, skuOperatore?: string | null,
): Promise<StatoSostituzione> {
  const conf = await configSostituzione(db)
  const { t, codice } = await leggiTicket(db, threadId)
  const esistente = await rigaEsistente(db, threadId)
  const base = {
    numero_ticket: t.numero,
    codice_prodotto: codice,
    valore_scontrino: t.valore_scontrino === null ? null : Number(t.valore_scontrino),
    cliente: { nome: t.nome, email: t.email, telefono: t.telefono },
    indirizzo_portale: t.indirizzo_portale,
    indirizzo_completo: indirizzoCompleto(t.indirizzo_portale) !== null,
    sostituzione: esistente,
    varianti_ambigue: [] as VarianteNegozio[],
  }
  if (esistente?.stato === 'fatta') {
    // Anche a sostituzione fatta il riquadro mostra prodotto e pezzi: senza
    // la lettura diceva "Non trovato sul negozio" (segnalato il 2026-11-26,
    // ordine INSH19984). Se la lettura fallisce resta vuoto, non è un errore.
    let variante: VarianteNegozio | null = null
    if (esistente.sku) {
      const s = await cercaVariante(config, log, esistente.sku).catch(() => null)
      if (s?.esito === 'trovata') variante = s.variante
    }
    return { ...base, sku: esistente.sku, variante, esito_ricerca: 'trovata', disponibile: false, azione: 'fatta', avviso: null }
  }
  if (!codice && !skuOperatore) {
    return {
      ...base, sku: null, variante: null, esito_ricerca: 'senza_codice', disponibile: false, azione: 'da_verificare',
      avviso: 'Nel ticket non trovo il codice del prodotto: indica lo SKU del negozio.',
    }
  }
  const sku = skuOperatore ? skuOperatore.trim().toUpperCase() : skuNegozio(codice!, conf.suffisso_sku)
  let scelta: SceltaVariante
  try {
    scelta = await cercaVariante(config, log, sku)
  } catch (e) {
    return {
      ...base, sku, variante: null, esito_ricerca: 'errore', disponibile: false, azione: 'da_verificare',
      avviso: e instanceof Error ? e.message : String(e),
    }
  }
  if (scelta.esito === 'ambigua') {
    return {
      ...base, sku, variante: null, esito_ricerca: 'ambigua', disponibile: false, varianti_ambigue: scelta.varianti,
      azione: 'da_verificare', avviso: `Sul negozio ci sono più varianti con SKU ${sku}: scegline una.`,
    }
  }
  if (scelta.esito === 'non_trovata') {
    // Mai un codice sconto solo perché il codice è scritto diversamente:
    // l'operatore controlla e indica lo SKU giusto.
    return {
      ...base, sku, variante: null, esito_ricerca: 'non_trovata', disponibile: false, azione: 'da_verificare',
      avviso: `${sku} non esiste sul negozio: controlla il codice e indica lo SKU giusto.`,
    }
  }
  if (!scelta.disponibile) {
    const variante = scelta.variante
    const motivo = `${sku} non è disponibile sul negozio`
    return {
      ...base, sku, variante, esito_ricerca: 'trovata', disponibile: false, azione: 'codice_sconto',
      avviso: base.valore_scontrino
        ? `${motivo}: puoi emettere un codice sconto di ${base.valore_scontrino.toFixed(2)} euro.`
        : `${motivo}, e il portale garanzie non ha letto il valore dallo scontrino: inserisci l'importo guardando lo scontrino.`,
    }
  }
  return { ...base, sku, variante: scelta.variante, esito_ricerca: 'trovata', disponibile: true, azione: 'spedisci', avviso: null }
}

/** Dopo quanto una richiesta rimasta "in corso" (worker caduto a metà) si può riprendere. */
const MINUTI_IN_CORSO = 5

/**
 * Prende il "posto" del sostitutivo per il ticket. Si riprende una riga in
 * errore, o rimasta in corso da più di qualche minuto; prima però si guarda
 * su Shopify se l'ordine o il codice esistono già.
 */
async function prenota(
  db: Db, threadId: string, tipo: RigaSostituzione['tipo'],
  dati: { sku: string; variant_gid?: string; agent_id: string | null },
): Promise<{ id: string; ripresa: RigaSostituzione | null }> {
  const prima = await rigaEsistente(db, threadId)
  const [r] = await db<{ id: string }[]>`
    insert into sostituzione (thread_id, tipo, stato, sku, variant_gid, agent_id)
    values (${threadId}, ${tipo}, 'in_corso', ${dati.sku}, ${dati.variant_gid ?? null}, ${dati.agent_id})
    on conflict (thread_id) do update set
      tipo = excluded.tipo, stato = 'in_corso', sku = excluded.sku, variant_gid = excluded.variant_gid,
      agent_id = excluded.agent_id, errore = null, updated_at = now()
    where sostituzione.stato = 'errore'
       or (sostituzione.stato = 'in_corso' and sostituzione.updated_at < now() - make_interval(mins => ${MINUTI_IN_CORSO}))
    returning id
  `
  if (r) return { id: r.id, ripresa: prima }
  const e = await rigaEsistente(db, threadId)
  if (e?.stato === 'fatta') {
    const cosa = e.tipo === 'ordine' ? `l'ordine ${e.shopify_order_name}` : `il codice sconto ${e.codice_sconto}`
    throw new ErroreSostituzione(409, `Per questo ticket c'è già ${cosa}.`, 'gia_fatta')
  }
  throw new ErroreSostituzione(409, 'Una richiesta per questo ticket è già in corso: aspetta qualche minuto.', 'in_corso')
}

async function segnaErrore(db: Db, id: string, threadId: string, tipo: string, errore: string): Promise<void> {
  await db`update sostituzione set stato = 'errore', errore = ${errore}, updated_at = now() where id = ${id}`
  await db`insert into ingest_anomaly (tipo, payload) values ('sostituzione_fallita', ${db.json({ thread_id: threadId, tipo, errore } as never)})`
}

/** Dopo che Shopify ha creato qualcosa, un errore nostro non deve mai portare a rifarlo. */
async function anomaliaDopo(db: Db, log: Logger, threadId: string, cosa: string, e: unknown): Promise<void> {
  const errore = e instanceof Error ? e.message : String(e)
  log.error({ thread_id: threadId, err: errore }, `${cosa}: creato su Shopify ma non registrato del tutto`)
  await db`insert into ingest_anomaly (tipo, payload) values ('sostituzione_registrazione', ${db.json({ thread_id: threadId, cosa, errore } as never)})`.catch(() => {})
}

async function notaInterna(db: Db, threadId: string, chiave: string, testo: string): Promise<void> {
  await db`
    insert into message (thread_id, direction, author_kind, external_id, body_text, interno, sent_at)
    values (${threadId}, 'out', 'agent', ${chiave}, ${testo}, true, now())
    on conflict (thread_id, external_id) do nothing
  `
}

const MUTAZIONE_ORDINE = `
  mutation Ordine($order: OrderCreateOrderInput!, $options: OrderCreateOptionsInput) {
    orderCreate(order: $order, options: $options) {
      order { id name totalPriceSet { shopMoney { amount } } }
      userErrors { field message }
    }
  }`

const QUERY_ORDINI_TICKET = `
  query OrdiniTicket($q: String!) {
    orders(first: 5, query: $q) { nodes { id name tags cancelledAt totalPriceSet { shopMoney { amount } } } }
  }`

interface OrdineCreato { id: string; name: string; totalPriceSet: { shopMoney: { amount: string } } }

/** Un ordine sostitutivo già creato per questo ticket (dopo un errore o un timeout). */
async function ordineGiaCreato(config: Config, log: Logger, numero: string, conf: ConfigSostituzione): Promise<OrdineCreato | null> {
  const d = await chiamaAdmin<{ orders: { nodes: (OrdineCreato & { tags: string[]; cancelledAt: string | null })[] } }>(
    config, log, QUERY_ORDINI_TICKET, { q: `tag:'ticket-${numero}'` },
  )
  return d.orders.nodes.find((o) => !o.cancelledAt && o.tags.includes(conf.tag_ordine) && o.tags.includes(`ticket-${numero}`)) ?? null
}

export interface RichiestaOrdine {
  thread_id: string
  /** Se manca, si usa quello dato dal cliente sul portale (se completo). */
  indirizzo?: Indirizzo | null
  email?: string | null
  /** Quando la ricerca per SKU è ambigua: la variante scelta dall'operatore. */
  variant_gid?: string | null
  /** Quando il codice del ticket non si trova sul negozio: lo SKU indicato dall'operatore. */
  sku?: string | null
  agent_id: string | null
}

export async function creaOrdineSostitutivo(db: Db, config: Config, log: Logger, r: RichiestaOrdine) {
  const conf = await configSostituzione(db)
  const stato = await statoSostituzione(db, config, log, r.thread_id, r.sku)
  if (stato.azione === 'fatta') throw new ErroreSostituzione(409, 'Per questo ticket il sostitutivo è già stato fatto.', 'gia_fatta')

  let variante = stato.variante
  if (stato.esito_ricerca === 'ambigua') {
    variante = stato.varianti_ambigue.find((v) => v.variant_gid === r.variant_gid) ?? null
    if (!variante) throw new ErroreSostituzione(422, 'Scegli quale variante spedire.', 'scegli_variante')
  }
  if (!variante || !varianteDisponibile(variante)) {
    throw new ErroreSostituzione(409, stato.avviso ?? 'Il prodotto non è disponibile: emetti il codice sconto.', 'non_disponibile')
  }
  const scelto = r.indirizzo ?? indirizzoCompleto(stato.indirizzo_portale)
  if (!scelto) {
    throw new ErroreSostituzione(422, "Manca l'indirizzo di spedizione: chiedilo al cliente.", 'senza_indirizzo')
  }

  const { id, ripresa } = await prenota(db, r.thread_id, 'ordine', { sku: variante.sku, variant_gid: variante.variant_gid, agent_id: r.agent_id })
  const email = r.email ?? stato.cliente.email
  const indirizzo = { ...scelto, telefono: scelto.telefono ?? stato.cliente.telefono }

  let ordine: OrdineCreato | null = null
  try {
    // Ripresa dopo un errore o un timeout: l'ordine potrebbe esserci già.
    if (ripresa) ordine = await ordineGiaCreato(config, log, stato.numero_ticket, conf)
    if (!ordine) {
      const input = inputOrdine({ numero_ticket: stato.numero_ticket, variant_gid: variante.variant_gid, email, indirizzo, conf })
      const d = await chiamaAdmin<{ orderCreate: { order: OrdineCreato | null; userErrors: { message: string }[] } }>(
        config, log, MUTAZIONE_ORDINE, input,
      )
      ordine = d.orderCreate.order
      if (!ordine) throw new ErroreShopify(d.orderCreate.userErrors.map((e) => e.message).join('; ') || 'ordine non creato')
    }
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    await segnaErrore(db, id, r.thread_id, 'ordine', msg)
    throw new ErroreSostituzione(e instanceof ErroreShopify && e.permessoMancante ? 403 : 502, msg, 'shopify')
  }

  // Da qui l'ordine esiste: niente più 'errore', al massimo un'anomalia.
  const totale = Number(ordine.totalPriceSet.shopMoney.amount)
  try {
    await db`
      update sostituzione set stato = 'fatta', shopify_order_gid = ${ordine.id}, shopify_order_name = ${ordine.name},
        indirizzo = ${db.json(indirizzo as never)}, errore = ${totale === 0 ? null : `totale ${totale} invece di 0`}, updated_at = now()
      where id = ${id}
    `
    await notaInterna(db, r.thread_id, `sostituzione:${id}`,
      `Sostitutivo spedito a 0 euro: ordine Shopify ${ordine.name} (${variante.sku}). Il tracking arriva con la spedizione.` +
        (totale === 0 ? '' : ` ATTENZIONE: su Shopify l'ordine risulta di ${totale.toFixed(2)} euro, va controllato.`))
    if (totale !== 0) await anomaliaDopo(db, log, r.thread_id, `ordine ${ordine.name} con totale ${totale}`, 'totale diverso da 0')
  } catch (e) {
    await anomaliaDopo(db, log, r.thread_id, `ordine ${ordine.name}`, e)
  }
  log.info({ thread_id: r.thread_id, ordine: ordine.name, sku: variante.sku, totale }, 'ordine sostitutivo creato')
  return { tipo: 'ordine' as const, ordine: ordine.name, shopify_order_gid: ordine.id, sku: variante.sku, totale }
}

const MUTAZIONE_SCONTO = `
  mutation Sconto($basicCodeDiscount: DiscountCodeBasicInput!) {
    discountCodeBasicCreate(basicCodeDiscount: $basicCodeDiscount) {
      codeDiscountNode { id }
      userErrors { field message }
    }
  }`

const QUERY_SCONTO_PER_CODICE = `
  query ScontoPerCodice($code: String!) { codeDiscountNodeByCode(code: $code) { id } }`

export async function creaCodiceScontoSostitutivo(
  db: Db, config: Config, log: Logger, r: { thread_id: string; sku?: string | null; agent_id: string | null; importo?: number | null },
) {
  const conf = await configSostituzione(db)
  const stato = await statoSostituzione(db, config, log, r.thread_id, r.sku)
  if (stato.azione === 'fatta') throw new ErroreSostituzione(409, 'Per questo ticket il sostitutivo è già stato fatto.', 'gia_fatta')
  if (stato.azione === 'spedisci') {
    throw new ErroreSostituzione(409, `${stato.sku} è disponibile: si spedisce il sostitutivo, niente codice sconto.`, 'disponibile')
  }
  // Solo quando il prodotto è stato trovato sul negozio e risulta esaurito.
  if (stato.azione !== 'codice_sconto') {
    throw new ErroreSostituzione(409, stato.avviso ?? 'Prima va verificato il prodotto.', 'da_verificare')
  }
  // Il valore letto dal portale vince. Se manca (ticket nati prima del
  // portale nuovo, scontrino illeggibile) lo inserisce l'operatore guardando
  // lo scontrino: si salva sul ticket con fonte 'operatore' (2026-11-26, #15861).
  let importo = stato.valore_scontrino
  if (!importo && r.importo && r.importo > 0) {
    importo = Math.round(r.importo * 100) / 100
    await db`
      update thread set valore_scontrino = ${importo}, valore_scontrino_fonte = 'operatore', updated_at = now()
      where id = ${r.thread_id} and valore_scontrino is null
    `
  }
  if (!importo) {
    throw new ErroreSostituzione(422, "Il portale garanzie non ha letto il valore dallo scontrino: inserisci l'importo a mano.", 'senza_valore')
  }

  const { id, ripresa } = await prenota(db, r.thread_id, 'codice_sconto', { sku: stato.sku ?? '', agent_id: r.agent_id })
  // Il codice si scrive PRIMA della chiamata: in una ripresa si cerca lo stesso codice su Shopify.
  const codice = ripresa?.tipo === 'codice_sconto' && ripresa.codice_sconto
    ? ripresa.codice_sconto
    : codiceSconto(conf.prefisso_codice, stato.numero_ticket)
  const { basicCodeDiscount, scade_il } = inputSconto({ codice, numero_ticket: stato.numero_ticket, importo, inizio: new Date(), conf })
  await db`update sostituzione set codice_sconto = ${codice}, importo = ${importo}, scade_il = ${scade_il} where id = ${id}`

  let nodoId: string | null = null
  try {
    if (ripresa) {
      const g = await chiamaAdmin<{ codeDiscountNodeByCode: { id: string } | null }>(config, log, QUERY_SCONTO_PER_CODICE, { code: codice })
      nodoId = g.codeDiscountNodeByCode?.id ?? null
    }
    if (!nodoId) {
      const d = await chiamaAdmin<{ discountCodeBasicCreate: { codeDiscountNode: { id: string } | null; userErrors: { message: string }[] } }>(
        config, log, MUTAZIONE_SCONTO, { basicCodeDiscount },
      )
      nodoId = d.discountCodeBasicCreate.codeDiscountNode?.id ?? null
      if (!nodoId) throw new ErroreShopify(d.discountCodeBasicCreate.userErrors.map((e) => e.message).join('; ') || 'codice non creato')
    }
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    await segnaErrore(db, id, r.thread_id, 'codice_sconto', msg)
    throw new ErroreSostituzione(e instanceof ErroreShopify && e.permessoMancante ? 403 : 502, msg, 'shopify')
  }

  try {
    await db`update sostituzione set stato = 'fatta', discount_gid = ${nodoId}, updated_at = now() where id = ${id}`
    const scadenza = scade_il.toLocaleDateString('it-IT', { timeZone: 'Europe/Rome' })
    await notaInterna(db, r.thread_id, `sostituzione:${id}`,
      `Prodotto non disponibile: emesso il codice sconto ${codice} da ${importo.toFixed(2)} euro, una sola volta, valido fino al ${scadenza}.`)
  } catch (e) {
    await anomaliaDopo(db, log, r.thread_id, `codice sconto ${codice}`, e)
  }
  log.info({ thread_id: r.thread_id, codice, importo }, 'codice sconto sostitutivo creato')
  return { tipo: 'codice_sconto' as const, codice, importo, scade_il }
}
