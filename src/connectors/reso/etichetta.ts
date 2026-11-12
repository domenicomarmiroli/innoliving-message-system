import type { Config } from '../../config.js'
import type { Db } from '../../db/index.js'
import type { Logger } from '../../logger.js'
import { caricaAllegato, scaricaAllegato } from '../../core/storage.js'
import { componiFoglioReso, ETICHETTA_TIPO, type TipoReso } from '../../core/reso/foglio.js'
import { configBrtResi, richiediEtichetta, type ConfigBrtResi } from '../brt/reso.js'
import { cercaOrdiniVendita, creaRigaLdvReso, zohoConfigurato } from '../zoho/client.js'

/**
 * Etichetta di reso BRT per un ticket (migrazione 0045).
 *
 * L'ordine delle operazioni protegge da due errori costosi:
 *  - due spedizioni BRT per lo stesso reso (doppio clic, retry di rete):
 *    la riga nasce 'in_corso' PRIMA della chiamata e il vincolo
 *    (thread, tipo) ferma la seconda richiesta;
 *  - una spedizione BRT creata e poi persa perché fallisce un passo
 *    successivo: segnacollo e PDF originale di BRT si salvano subito dopo
 *    la risposta. Se poi fallisce la composizione del foglio, la richiesta
 *    successiva riparte da lì senza richiamare BRT.
 * Zoho viene per ultimo e non fa mai fallire l'etichetta: un errore resta
 * in `zoho_errore` e in `ingest_anomaly`, e si riprova alla richiesta
 * successiva sullo stesso ticket.
 */

export class ErroreEtichetta extends Error {
  constructor(public readonly status: number, messaggio: string) {
    super(messaggio)
  }
}

export interface EtichettaPronta {
  id: string
  tipo: TipoReso
  parcel_id: string
  tracking_parcel_id: string | null
  storage_path: string
  nome_file: string
  mime: 'application/pdf'
  zoho_ordine: string | null
  zoho_scritto: boolean
  zoho_errore: string | null
  gia_esistente: boolean
  /** Dati dell'ordine usati per l'etichetta: servono a comporre il testo per il cliente. */
  numero_ordine: string
  nome_cliente: string
}

/** Numero dell'ordine di vendita Zoho quando si può ricavare senza chiedere: solo Amazon. */
export function numeroOrdineVendita(canale: string, numeroCanale: string, prefissoAmazon: string): string | null {
  return canale === 'amazon' && /^\d{3}-\d{7}-\d{7}$/.test(numeroCanale) ? `${prefissoAmazon}${numeroCanale}` : null
}

/** Riferimento stampato in etichetta (max 15 caratteri): il numero del nostro ticket. */
export function riferimentoBrt(numeroTicket: number | string): string {
  return `TICKET ${numeroTicket}`.slice(0, 15)
}

interface Riga {
  id: string
  stato: 'in_corso' | 'creata' | 'fallita'
  parcel_id: string | null
  tracking_parcel_id: string | null
  storage_path: string | null
  nome_file: string | null
  zoho_ordine: string | null
  zoho_scritto_at: Date | null
  zoho_errore: string | null
  raw: { pdf_brt?: string } | null
  aggiornata_da_secondi: number
}

const COLONNE = (db: Db) => db`id, stato, parcel_id, tracking_parcel_id, storage_path, nome_file, zoho_ordine, zoho_scritto_at, zoho_errore, raw,
  extract(epoch from now() - updated_at)::int as aggiornata_da_secondi`

/** Una richiesta 'in_corso' più vecchia di così è considerata abbandonata (processo riavviato a metà). */
const IN_CORSO_ABBANDONATA_S = 120

/** A chi appartiene l'etichetta: un ticket oppure, senza ticket, un ordine (canale + numero). */
interface Bersaglio {
  thread_id: string | null
  canale: string
  numero_ordine: string
  order_id: string | null
  shopify_name: string | null
  nome_cliente: string
  /** Riferimento stampato in etichetta (max 15 caratteri). */
  riferimento: string
  /** Cartella su Storage. */
  cartella: string
}

/** Riferimento in etichetta per un reso senza ticket: il numero d'ordine, o le sue ultime 15 cifre. */
export function riferimentoBrtOrdine(numeroOrdine: string): string {
  return numeroOrdine.length <= 15 ? numeroOrdine : numeroOrdine.slice(-15)
}

const FORMA_ORDINE_AMAZON = /^\d{3}-\d{7}-\d{7}$/

/**
 * Canale, numero e nome per l'etichetta di un ticket senza ordine collegato.
 *
 * Vale per i ticket di garanzia (tag `garanzia`) e per quelli in cui il
 * cliente ha dichiarato un numero d'ordine che non è (ancora) in archivio.
 * Un numero con la forma di un ordine Amazon fa del canale `amazon`, così
 * Zoho trova l'ordine di vendita; altrimenti il canale è l'account del
 * ticket. Senza numero dichiarato si usa il ticket stesso come riferimento.
 * Null = non ci sono dati a sufficienza: serve collegare un ordine.
 */
export function bersaglioSenzaOrdine(d: {
  numero_ticket: number | null
  account_code: string
  tags: string[]
  numero_dichiarato: string | null
  nome: string | null
}): { canale: string; numero_ordine: string; nome_cliente: string } | null {
  const dichiarato = d.numero_dichiarato?.trim().replace(/^#/, '') || null
  const garanzia = d.tags.includes('garanzia')
  if (!dichiarato && !garanzia) return null
  if (!dichiarato && d.numero_ticket === null) return null
  return {
    canale: dichiarato && FORMA_ORDINE_AMAZON.test(dichiarato) ? 'amazon' : d.account_code,
    numero_ordine: dichiarato ?? `TICKET-${d.numero_ticket}`,
    nome_cliente: d.nome?.trim() || 'Cliente',
  }
}

/** Normalizza un pezzo di percorso Storage. */
function pezzoPercorso(v: string): string {
  return v.replace(/[^A-Za-z0-9._-]+/g, '-').slice(0, 60)
}

export async function generaEtichettaReso(
  db: Db,
  config: Config,
  log: Logger,
  richiesta: { thread_id: string; tipo: TipoReso; agent_id: string | null },
): Promise<EtichettaPronta> {
  const [t] = await db<{
    numero: number | null; order_id: string | null; channel: string | null; external_order_id: string | null
    shopify_name: string | null; nome_spedizione: string | null; nome_fatturazione: string | null
  }[]>`
    select t.numero, t.order_id, o.channel, o.external_order_id, o.shopify_name,
      o.shipping_address->>'nome' as nome_spedizione, o.billing_address->>'nome' as nome_fatturazione
    from thread t left join "order" o on o.id = t.order_id
    where t.id = ${richiesta.thread_id}
  `
  if (!t) throw new ErroreEtichetta(404, 'ticket inesistente')
  if (!t.order_id || !t.external_order_id) {
    // Ticket senza ordine in archivio (tipico dei portali garanzia: acquisto
    // in negozio, o ordine marketplace precedente alla sincronizzazione):
    // bastano i dati che il cliente ha lasciato aprendo il ticket.
    const [d] = await db<{
      account_code: string; tags: string[] | null; dichiarato: string | null; nome: string | null
    }[]>`
      select ca.code as account_code, th.tags,
        (select m.raw->>'numero_ordine_dichiarato' from message m
          where m.thread_id = th.id and m.direction = 'in' and m.author_kind = 'customer'
            and m.raw ? 'numero_ordine_dichiarato'
          order by m.sent_at limit 1) as dichiarato,
        (select m.raw->>'nome' from message m
          where m.thread_id = th.id and m.direction = 'in' and m.author_kind = 'customer'
            and coalesce(m.raw->>'nome', '') <> ''
          order by m.sent_at limit 1) as nome
      from thread th join channel_account ca on ca.id = th.account_id
      where th.id = ${richiesta.thread_id}
    `
    const senza = d
      ? bersaglioSenzaOrdine({
          numero_ticket: t.numero,
          account_code: d.account_code,
          tags: d.tags ?? [],
          numero_dichiarato: d.dichiarato,
          nome: d.nome,
        })
      : null
    if (!senza) throw new ErroreEtichetta(422, "il ticket non è collegato a un ordine: collegalo prima di generare l'etichetta")
    return produciEtichetta(db, config, log, {
      thread_id: richiesta.thread_id,
      canale: senza.canale,
      numero_ordine: senza.numero_ordine,
      order_id: null,
      shopify_name: null,
      nome_cliente: senza.nome_cliente,
      riferimento: riferimentoBrt(t.numero ?? senza.numero_ordine),
      cartella: `etichette-reso/${richiesta.thread_id}`,
    }, richiesta.tipo, richiesta.agent_id)
  }

  return produciEtichetta(db, config, log, {
    thread_id: richiesta.thread_id,
    canale: t.channel ?? '',
    numero_ordine: t.external_order_id,
    order_id: t.order_id,
    shopify_name: t.shopify_name,
    nome_cliente: (t.nome_spedizione ?? t.nome_fatturazione ?? '').trim() || 'Cliente',
    riferimento: riferimentoBrt(t.numero ?? t.external_order_id),
    cartella: `etichette-reso/${richiesta.thread_id}`,
  }, richiesta.tipo, richiesta.agent_id)
}

/**
 * Etichetta di reso da numero d'ordine, senza ticket. Se l'ordine è nell'Hub
 * si prendono canale e nome dal database; se non c'è (BricoBravo e ogni canale
 * non integrato) servono `canale` e `nome_cliente` digitati dall'operatore.
 * Stessa idempotenza del ticket: chiave (canale, numero d'ordine, tipo).
 */
export async function generaEtichettaResoOrdine(
  db: Db,
  config: Config,
  log: Logger,
  richiesta: { numero_ordine: string; tipo: TipoReso; canale?: string | null; nome_cliente?: string | null; agent_id: string | null },
): Promise<EtichettaPronta> {
  const numero = richiesta.numero_ordine.trim()
  const senzaCancelletto = numero.replace(/^#/, '')
  const canaleDato = richiesta.canale?.trim().toLowerCase() || null
  const nomeDato = richiesta.nome_cliente?.trim() || null

  const trovati = await db<{
    id: string; channel: string; external_order_id: string; shopify_name: string | null
    nome_spedizione: string | null; nome_fatturazione: string | null
  }[]>`
    select o.id, o.channel, o.external_order_id, o.shopify_name,
      o.shipping_address->>'nome' as nome_spedizione, o.billing_address->>'nome' as nome_fatturazione
    from "order" o
    where (o.external_order_id in (${numero}, ${senzaCancelletto})
        or o.shopify_name in (${senzaCancelletto}, ${'#' + senzaCancelletto}))
      and (${canaleDato}::text is null or lower(o.channel) = ${canaleDato})
    order by o.placed_at desc nulls last
    limit 3
  `
  if (trovati.length > 1 && !canaleDato) {
    throw new ErroreEtichetta(409, `il numero ${numero} esiste su più canali (${trovati.map((o) => o.channel).join(', ')}): indica il canale`)
  }
  const ordine = trovati[0]

  if (ordine) {
    return produciEtichetta(db, config, log, {
      thread_id: null,
      canale: ordine.channel,
      numero_ordine: ordine.external_order_id,
      order_id: ordine.id,
      shopify_name: ordine.shopify_name,
      nome_cliente: nomeDato ?? ((ordine.nome_spedizione ?? ordine.nome_fatturazione ?? '').trim() || 'Cliente'),
      riferimento: riferimentoBrtOrdine(ordine.external_order_id),
      cartella: `etichette-reso/ordine-${pezzoPercorso(ordine.channel)}-${pezzoPercorso(ordine.external_order_id)}`,
    }, richiesta.tipo, richiesta.agent_id)
  }

  if (!canaleDato || !nomeDato) {
    throw new ErroreEtichetta(422, `ordine ${numero} non trovato nell'Hub: indica il canale (per esempio bricobravo) e il nome del cliente`)
  }
  return produciEtichetta(db, config, log, {
    thread_id: null,
    canale: canaleDato,
    numero_ordine: senzaCancelletto,
    order_id: null,
    shopify_name: null,
    nome_cliente: nomeDato,
    riferimento: riferimentoBrtOrdine(senzaCancelletto),
    cartella: `etichette-reso/ordine-${pezzoPercorso(canaleDato)}-${pezzoPercorso(senzaCancelletto)}`,
  }, richiesta.tipo, richiesta.agent_id)
}

async function produciEtichetta(
  db: Db,
  config: Config,
  log: Logger,
  b: Bersaglio,
  tipo: TipoReso,
  agentId: string | null,
): Promise<EtichettaPronta> {
  if (!config.BRT_API_USER || !config.BRT_API_PASSWORD) throw new ErroreEtichetta(503, 'BRT non configurato: mancano BRT_API_USER e BRT_API_PASSWORD.')

  const [cfgRiga] = await db<{ value: unknown }[]>`select value from app_config where key = 'brt_resi'`
  const cfg = configBrtResi.safeParse(cfgRiga?.value)
  if (!cfg.success) throw new ErroreEtichetta(503, `app_config.brt_resi mancante o incompleta: ${cfg.error.issues.map((i) => i.path.join('.')).join(', ')}`)
  const conf = cfg.data

  const filtro = b.thread_id
    ? db`thread_id = ${b.thread_id} and tipo = ${tipo}`
    : db`thread_id is null and canale = ${b.canale} and numero_ordine = ${b.numero_ordine} and tipo = ${tipo}`

  // 1. Prenoto la riga. Se esiste già, decido se restituirla, aspettare o riprendere.
  let [riga] = b.thread_id
    ? await db<Riga[]>`
        insert into etichetta_reso (thread_id, order_id, canale, numero_ordine, nome_cliente, tipo, agent_id)
        values (${b.thread_id}, ${b.order_id}, ${b.canale || null}, ${b.numero_ordine}, ${b.nome_cliente}, ${tipo}, ${agentId})
        on conflict (thread_id, tipo) do nothing
        returning ${COLONNE(db)}
      `
    : await db<Riga[]>`
        insert into etichetta_reso (order_id, canale, numero_ordine, nome_cliente, tipo, agent_id)
        values (${b.order_id}, ${b.canale}, ${b.numero_ordine}, ${b.nome_cliente}, ${tipo}, ${agentId})
        on conflict (canale, numero_ordine, tipo) where thread_id is null do nothing
        returning ${COLONNE(db)}
      `
  let giaEsistente = false
  if (!riga) {
    giaEsistente = true
    ;[riga] = await db<Riga[]>`select ${COLONNE(db)} from etichetta_reso where ${filtro}`
    if (!riga) throw new ErroreEtichetta(500, 'etichetta non trovata dopo il conflitto')
    if (riga.stato === 'in_corso' && riga.aggiornata_da_secondi < IN_CORSO_ABBANDONATA_S) {
      throw new ErroreEtichetta(409, "l'etichetta è già in preparazione: riprova fra qualche secondo")
    }
    if (riga.stato !== 'creata') {
      const [ripresa] = await db<Riga[]>`
        update etichetta_reso set stato = 'in_corso', errore = null, updated_at = now()
        where id = ${riga.id} and stato <> 'creata'
          and (stato = 'fallita' or updated_at < now() - make_interval(secs => ${IN_CORSO_ABBANDONATA_S}))
        returning ${COLONNE(db)}
      `
      if (!ripresa) throw new ErroreEtichetta(409, "l'etichetta è già in preparazione: riprova fra qualche secondo")
      riga = ripresa
    }
  }

  const idRiga = riga.id
  try {
    // 2. BRT, solo se questa riga non ha ancora una spedizione.
    let pdfBrt: Buffer
    if (riga.parcel_id && riga.raw?.pdf_brt) {
      pdfBrt = await scaricaAllegato(config, riga.raw.pdf_brt)
    } else {
      const esito = await richiediEtichetta(conf, { utente: config.BRT_API_USER, password: config.BRT_API_PASSWORD }, {
        nome_cliente: b.nome_cliente,
        riferimento: b.riferimento,
        note: b.numero_ordine,
      })
      if (!esito.ok) {
        await db`update etichetta_reso set stato = 'fallita', errore = ${esito.errore.slice(0, 500)}, raw = ${db.json(esito.raw as never)}, updated_at = now() where id = ${riga.id}`
        await db`insert into ingest_anomaly (tipo, payload) values ('etichetta_reso_brt_fallita', ${db.json({ thread_id: b.thread_id, canale: b.canale, numero_ordine: b.numero_ordine, tipo, errore: esito.errore, risposta: esito.raw } as never)})`
        throw new ErroreEtichetta(502, `BRT non ha creato l'etichetta: ${esito.errore}`)
      }
      pdfBrt = esito.pdf
      const percorsoBrt = await caricaAllegato(config, `${b.cartella}/${esito.parcel_id}-brt.pdf`, pdfBrt, 'application/pdf')
      const raw = { ...(esito.raw as object), pdf_brt: percorsoBrt }
      ;[riga] = await db<Riga[]>`
        update etichetta_reso set parcel_id = ${esito.parcel_id}, tracking_parcel_id = ${esito.tracking_parcel_id},
          raw = ${db.json(raw as never)}, updated_at = now()
        where id = ${riga.id} returning ${COLONNE(db)}
      `
      log.info({ thread_id: b.thread_id, canale: b.canale, numero_ordine: b.numero_ordine, parcel_id: esito.parcel_id }, 'etichetta di reso BRT creata')
    }
    if (!riga?.parcel_id) throw new ErroreEtichetta(500, 'segnacollo mancante dopo la creazione')

    // 3. Foglio per il cliente.
    if (!riga.storage_path) {
      const foglio = await componiFoglioReso({ tipo, etichettaBrt: pdfBrt, testi: conf.foglio })
      const nomeFile = `Reso ${b.numero_ordine} - ${ETICHETTA_TIPO[tipo].toLowerCase()}.pdf`.replace(/[\\/:*?"<>|]/g, '-')
      const percorso = await caricaAllegato(config, `${b.cartella}/${riga.parcel_id}.pdf`, foglio, 'application/pdf')
      ;[riga] = await db<Riga[]>`
        update etichetta_reso set storage_path = ${percorso}, nome_file = ${nomeFile}, stato = 'creata', errore = null, updated_at = now()
        where id = ${riga.id} returning ${COLONNE(db)}
      `
    } else if (riga.stato !== 'creata') {
      ;[riga] = await db<Riga[]>`update etichetta_reso set stato = 'creata', updated_at = now() where id = ${riga.id} returning ${COLONNE(db)}`
    }
    if (!riga?.storage_path || !riga.parcel_id) throw new ErroreEtichetta(500, 'foglio non salvato')
  } catch (e) {
    if (!(e instanceof ErroreEtichetta)) {
      const messaggio = e instanceof Error ? e.message : String(e)
      await db`update etichetta_reso set stato = 'fallita', errore = ${messaggio.slice(0, 500)}, updated_at = now() where id = ${idRiga}`
      throw new ErroreEtichetta(502, `etichetta non completata: ${messaggio}`)
    }
    throw e
  }

  // 4. Zoho, come faceva il vecchio worker. Mai bloccante.
  const creata: Riga | undefined = riga
  if (!creata) throw new ErroreEtichetta(500, 'etichetta non trovata dopo la creazione')
  riga = creata.zoho_scritto_at
    ? creata
    : await scriviSuZoho(db, config, log, conf, creata, tipo, b.canale, b.numero_ordine, b.shopify_name)

  return {
    id: riga.id,
    tipo,
    parcel_id: riga.parcel_id!,
    tracking_parcel_id: riga.tracking_parcel_id,
    storage_path: riga.storage_path!,
    nome_file: riga.nome_file ?? `${riga.parcel_id}.pdf`,
    mime: 'application/pdf',
    zoho_ordine: riga.zoho_ordine,
    zoho_scritto: !!riga.zoho_scritto_at,
    zoho_errore: riga.zoho_errore,
    gia_esistente: giaEsistente,
    numero_ordine: b.numero_ordine,
    nome_cliente: b.nome_cliente,
  }
}

async function scriviSuZoho(
  db: Db, config: Config, log: Logger, conf: ConfigBrtResi, riga: Riga, tipo: TipoReso,
  canale: string, numeroCanale: string, nomeShopify: string | null,
): Promise<Riga> {
  let ordine = riga.zoho_ordine
  try {
    if (!zohoConfigurato(config)) throw new Error('Zoho non configurato (ZOHO_CLIENT_ID, ZOHO_CLIENT_SECRET, ZOHO_REFRESH_TOKEN, ZOHO_ORGANIZATION_ID)')
    ordine ??= numeroOrdineVendita(canale, numeroCanale, conf.zoho.prefisso_amazon)
    if (!ordine) {
      for (const cercato of [numeroCanale, nomeShopify].filter((x): x is string => !!x)) {
        const pulito = cercato.replace(/^#/, '')
        const trovati = await cercaOrdiniVendita(config, pulito)
        const giusto = trovati.find((o) => o.reference_number === pulito || o.salesorder_number.endsWith(pulito))
        if (giusto) { ordine = giusto.salesorder_number; break }
      }
    }
    if (!ordine) throw new Error(`ordine di vendita Zoho non trovato per ${numeroCanale}`)
    await creaRigaLdvReso(config, conf.zoho.modulo, {
      data: new Date().toISOString().slice(0, 10), segnacollo: riga.parcel_id!, ordine, tipologia: ETICHETTA_TIPO[tipo],
    })
    const [aggiornata] = await db<Riga[]>`
      update etichetta_reso set zoho_ordine = ${ordine}, zoho_scritto_at = now(), zoho_errore = null, updated_at = now()
      where id = ${riga.id} returning ${COLONNE(db)}
    `
    return aggiornata ?? riga
  } catch (e) {
    const messaggio = (e instanceof Error ? e.message : String(e)).slice(0, 500)
    log.warn({ etichetta_id: riga.id, errore: messaggio }, 'riga LDV Reso su Zoho non scritta')
    await db`insert into ingest_anomaly (tipo, payload) values ('etichetta_reso_zoho_non_scritta', ${db.json({ etichetta_id: riga.id, parcel_id: riga.parcel_id, ordine, errore: messaggio })})`
    const [aggiornata] = await db<Riga[]>`
      update etichetta_reso set zoho_ordine = ${ordine}, zoho_errore = ${messaggio}, updated_at = now()
      where id = ${riga.id} returning ${COLONNE(db)}
    `
    return aggiornata ?? riga
  }
}
