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

export async function generaEtichettaReso(
  db: Db,
  config: Config,
  log: Logger,
  richiesta: { thread_id: string; tipo: TipoReso; agent_id: string | null },
): Promise<EtichettaPronta> {
  if (!config.BRT_API_USER || !config.BRT_API_PASSWORD) throw new ErroreEtichetta(503, 'BRT non configurato: mancano BRT_API_USER e BRT_API_PASSWORD.')

  const [cfgRiga] = await db<{ value: unknown }[]>`select value from app_config where key = 'brt_resi'`
  const cfg = configBrtResi.safeParse(cfgRiga?.value)
  if (!cfg.success) throw new ErroreEtichetta(503, `app_config.brt_resi mancante o incompleta: ${cfg.error.issues.map((i) => i.path.join('.')).join(', ')}`)
  const conf = cfg.data

  const [t] = await db<{
    numero: number | null; order_id: string | null; channel: string | null; external_order_id: string | null
    shopify_name: string | null; nome_spedizione: string | null; nome_fatturazione: string | null
  }[]>`
    select t.numero, t.order_id, o.channel, o.external_order_id, o.shopify_name,
      o.shipping_address->>'name' as nome_spedizione, o.billing_address->>'name' as nome_fatturazione
    from thread t left join "order" o on o.id = t.order_id
    where t.id = ${richiesta.thread_id}
  `
  if (!t) throw new ErroreEtichetta(404, 'ticket inesistente')
  if (!t.order_id || !t.external_order_id) throw new ErroreEtichetta(422, "il ticket non è collegato a un ordine: collegalo prima di generare l'etichetta")

  // 1. Prenoto la riga. Se esiste già, decido se restituirla, aspettare o riprendere.
  let [riga] = await db<Riga[]>`
    insert into etichetta_reso (thread_id, order_id, tipo, agent_id)
    values (${richiesta.thread_id}, ${t.order_id}, ${richiesta.tipo}, ${richiesta.agent_id})
    on conflict (thread_id, tipo) do nothing
    returning ${COLONNE(db)}
  `
  let giaEsistente = false
  if (!riga) {
    giaEsistente = true
    ;[riga] = await db<Riga[]>`select ${COLONNE(db)} from etichetta_reso where thread_id = ${richiesta.thread_id} and tipo = ${richiesta.tipo}`
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
      const nome = (t.nome_spedizione ?? t.nome_fatturazione ?? '').trim() || 'Cliente'
      const esito = await richiediEtichetta(conf, { utente: config.BRT_API_USER, password: config.BRT_API_PASSWORD }, {
        nome_cliente: nome,
        riferimento: riferimentoBrt(t.numero ?? t.external_order_id),
        note: t.external_order_id,
      })
      if (!esito.ok) {
        await db`update etichetta_reso set stato = 'fallita', errore = ${esito.errore.slice(0, 500)}, raw = ${db.json(esito.raw as never)}, updated_at = now() where id = ${riga.id}`
        await db`insert into ingest_anomaly (tipo, payload) values ('etichetta_reso_brt_fallita', ${db.json({ thread_id: richiesta.thread_id, tipo: richiesta.tipo, errore: esito.errore, risposta: esito.raw } as never)})`
        throw new ErroreEtichetta(502, `BRT non ha creato l'etichetta: ${esito.errore}`)
      }
      pdfBrt = esito.pdf
      const percorsoBrt = await caricaAllegato(config, `etichette-reso/${richiesta.thread_id}/${esito.parcel_id}-brt.pdf`, pdfBrt, 'application/pdf')
      const raw = { ...(esito.raw as object), pdf_brt: percorsoBrt }
      ;[riga] = await db<Riga[]>`
        update etichetta_reso set parcel_id = ${esito.parcel_id}, tracking_parcel_id = ${esito.tracking_parcel_id},
          raw = ${db.json(raw as never)}, updated_at = now()
        where id = ${riga.id} returning ${COLONNE(db)}
      `
      log.info({ thread_id: richiesta.thread_id, parcel_id: esito.parcel_id }, 'etichetta di reso BRT creata')
    }
    if (!riga?.parcel_id) throw new ErroreEtichetta(500, 'segnacollo mancante dopo la creazione')

    // 3. Foglio per il cliente.
    if (!riga.storage_path) {
      const foglio = await componiFoglioReso({ tipo: richiesta.tipo, etichettaBrt: pdfBrt, testi: conf.foglio })
      const nomeFile = `Reso ${t.external_order_id} - ${ETICHETTA_TIPO[richiesta.tipo].toLowerCase()}.pdf`.replace(/[\\/:*?"<>|]/g, '-')
      const percorso = await caricaAllegato(config, `etichette-reso/${richiesta.thread_id}/${riga.parcel_id}.pdf`, foglio, 'application/pdf')
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
    : await scriviSuZoho(db, config, log, conf, creata, richiesta.tipo, t.channel ?? '', t.external_order_id, t.shopify_name)

  return {
    id: riga.id,
    tipo: richiesta.tipo,
    parcel_id: riga.parcel_id!,
    tracking_parcel_id: riga.tracking_parcel_id,
    storage_path: riga.storage_path!,
    nome_file: riga.nome_file ?? `${riga.parcel_id}.pdf`,
    mime: 'application/pdf',
    zoho_ordine: riga.zoho_ordine,
    zoho_scritto: !!riga.zoho_scritto_at,
    zoho_errore: riga.zoho_errore,
    gia_esistente: giaEsistente,
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
