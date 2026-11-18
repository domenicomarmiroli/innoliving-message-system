import type { Config } from '../../config.js'
import type { Db } from '../../db/index.js'
import type { Logger } from '../../logger.js'
import { configBrtResi } from './reso.js'
import { statoDaEventi, type EventoBrt, type StatoBrt } from './pagina.js'

/**
 * Stato della spedizione di reso (migrazione 0054).
 *
 * Il reso nasce con l'etichetta BRT creata dall'Hub: BRT ci dà il
 * segnacollo a 18 cifre e `trackingByParcelID` a 15, che è proprio la
 * chiave del servizio REST di tracking (`GET /tracking/parcelID/{id}`,
 * stesse credenziali dell'etichetta). Non serve la pagina pubblica, che
 * vuole il numero a 12 cifre che per i resi non abbiamo.
 *
 * Il giro rilegge ogni etichetta `creata` e non ancora consegnata al
 * magazzino ogni `BRT_TRACKING_RESI_ORE`. Prima che il cliente porti il
 * pacco al punto BRT il servizio non trova niente: non è un errore, lo
 * stato è `in_attesa`.
 *
 * La risposta del servizio non è stata ancora vista dal vivo su un reso:
 * `leggiRisposta()` accetta più forme di data e di ora e, se la risposta
 * non somiglia a quella attesa, restituisce `riconosciuta: false` invece
 * di inventare uno stato (stessa regola del tracking dalla pagina).
 */

/** Stato del reso: quelli del tracking normale, più "BRT non ha ancora il pacco". */
export type StatoReso = StatoBrt | 'in_attesa'

export type EsitoLettura =
  | { riconosciuta: true; trovata: false }
  | { riconosciuta: true; trovata: true; eventi: EventoBrt[]; stato: StatoReso }
  | { riconosciuta: false; motivo: string }

const GIORNI_FINESTRA = 60
const MASSIMO_PER_GIRO = 100
const PAUSA_MS = 1000
const ERRORI_DI_FILA_MASSIMI = 3

/** URL del servizio di tracking, ricavato dall'endpoint delle spedizioni in `app_config.brt_resi`. */
export function urlTrackingReso(endpointSpedizioni: string, trackingParcelId: string): string {
  const base = endpointSpedizioni.replace(/\/shipments\/shipment\/?$/, '')
  return `${base}/tracking/parcelID/${encodeURIComponent(trackingParcelId)}`
}

/** `2026-11-16`, `16.11.2026`, `16/11/2026`, `20261116` → ISO; altro → null. */
export function dataIso(v: unknown): string | null {
  if (typeof v !== 'string') return null
  const s = v.trim()
  let m = /^(\d{4})-(\d{2})-(\d{2})/.exec(s)
  if (m) return `${m[1]}-${m[2]}-${m[3]}`
  m = /^(\d{2})[./-](\d{2})[./-](\d{4})$/.exec(s)
  if (m) return `${m[3]}-${m[2]}-${m[1]}`
  m = /^(\d{4})(\d{2})(\d{2})$/.exec(s)
  if (m) return `${m[1]}-${m[2]}-${m[3]}`
  return null
}

/** `10:15`, `10.15`, `10:15:00`, `1015` → `10:15`; altro → null. */
export function oraBreve(v: unknown): string | null {
  if (typeof v !== 'string') return null
  const m = /^(\d{1,2})[.:]?(\d{2})/.exec(v.trim())
  return m ? `${m[1]!.padStart(2, '0')}:${m[2]}` : null
}

function testoOppure(v: unknown): string | null {
  if (typeof v === 'string') return v.trim() || null
  if (typeof v === 'number') return String(v)
  return null
}

/**
 * Legge la risposta del servizio. Forma attesa:
 * `{ bolla: { esito, lista_eventi: [{ evento: { data, ora, descrizione, filiale: { nome } } }] } }`.
 * Senza eventi, o con un esito negativo, BRT non ha (ancora) il pacco.
 */
export function leggiRisposta(corpo: unknown): EsitoLettura {
  const bolla = (corpo as { bolla?: Record<string, unknown> } | null)?.bolla
  if (!bolla || typeof bolla !== 'object') return { riconosciuta: false, motivo: 'manca "bolla" nella risposta' }

  const lista = bolla.lista_eventi
  const esito = typeof bolla.esito === 'number' ? bolla.esito : Number(bolla.esito ?? 0)
  if (lista === undefined || lista === null || (Array.isArray(lista) && lista.length === 0)) {
    // Un esito negativo senza eventi è "spedizione non trovata"; senza esito
    // e senza eventi la bolla c'è ma il pacco non è ancora stato scansionato.
    return { riconosciuta: true, trovata: false }
  }
  if (!Array.isArray(lista)) return { riconosciuta: false, motivo: '"lista_eventi" non è una lista' }
  if (Number.isFinite(esito) && esito < 0 && lista.length === 0) return { riconosciuta: true, trovata: false }

  const eventi: EventoBrt[] = []
  for (const voce of lista) {
    const e = ((voce as { evento?: unknown })?.evento ?? voce) as Record<string, unknown>
    const descrizione = testoOppure(e?.descrizione) ?? testoOppure(e?.evento)
    const data = dataIso(e?.data)
    if (!descrizione || !data) return { riconosciuta: false, motivo: 'evento senza data o descrizione' }
    const filiale = e.filiale as Record<string, unknown> | string | undefined
    eventi.push({
      data,
      ora: oraBreve(e.ora),
      filiale: typeof filiale === 'string' ? filiale.trim() || null : testoOppure(filiale?.nome),
      evento: descrizione,
    })
  }
  // Dal più recente: la risposta può arrivare in un ordine o nell'altro.
  eventi.sort((a, b) => `${b.data} ${b.ora ?? ''}`.localeCompare(`${a.data} ${a.ora ?? ''}`))

  return { riconosciuta: true, trovata: true, eventi, stato: statoReso(eventi) }
}

/**
 * Stato di un reso dagli eventi. Come per le spedizioni in uscita, ma qui il
 * pacco va dal cliente a noi: "rientrato al mittente" non ha senso (il
 * mittente è il cliente), quindi diventa un normale transito.
 */
export function statoReso(eventi: EventoBrt[]): StatoReso {
  const stato = statoDaEventi(eventi, null)
  return stato === 'rientrato' ? 'in_transito' : stato
}

async function chiediTracking(
  url: string,
  credenziali: { utente: string; password: string },
): Promise<{ stato: number; corpo: unknown }> {
  const risposta = await fetch(url, {
    headers: { Accept: 'application/json', userID: credenziali.utente, password: credenziali.password },
    signal: AbortSignal.timeout(20_000),
  })
  const testo = await risposta.text()
  let corpo: unknown = null
  try {
    corpo = JSON.parse(testo)
  } catch {
    /* corpo non JSON: lo gestisce il chiamante dallo stato HTTP */
  }
  return { stato: risposta.status, corpo }
}

export interface EsitoGiroResi {
  letti: number
  aggiornati: number
  in_attesa: number
  non_riconosciuti: number
  errori: number
  interrotto: boolean
}

interface DaLeggere {
  id: string
  tracking_parcel_id: string
}

const pausa = (ms: number) => new Promise((r) => setTimeout(r, ms))

export async function giroTrackingResi(
  db: Db,
  log: Logger,
  config: Config,
  fermato: () => boolean = () => false,
): Promise<EsitoGiroResi> {
  const esito: EsitoGiroResi = { letti: 0, aggiornati: 0, in_attesa: 0, non_riconosciuti: 0, errori: 0, interrotto: false }
  if (config.BRT_TRACKING_RESI_ORE === 0 || !config.BRT_API_USER || !config.BRT_API_PASSWORD) return esito

  const daLeggere = await db<DaLeggere[]>`
    select id, tracking_parcel_id
    from etichetta_reso
    where stato = 'creata'
      and tracking_parcel_id is not null
      and spedizione_stato is distinct from 'consegnato'
      and created_at > now() - make_interval(days => ${GIORNI_FINESTRA})
      and (tracking_letto_at is null
           or tracking_letto_at < now() - make_interval(hours => ${config.BRT_TRACKING_RESI_ORE}))
    order by tracking_letto_at nulls first
    limit ${MASSIMO_PER_GIRO}
  `
  if (daLeggere.length === 0) return esito

  const [cfgRiga] = await db<{ value: unknown }[]>`select value from app_config where key = 'brt_resi'`
  const cfg = configBrtResi.safeParse(cfgRiga?.value)
  if (!cfg.success) {
    log.warn({}, 'app_config.brt_resi mancante o incompleta: tracking dei resi saltato')
    return esito
  }
  const credenziali = { utente: config.BRT_API_USER, password: config.BRT_API_PASSWORD }

  const nonRiconosciuti: { id: string; motivo: string; http: number; risposta: string | null }[] = []
  let erroriDiFila = 0

  for (const r of daLeggere) {
    if (fermato()) break
    if (esito.letti > 0) await pausa(PAUSA_MS)
    esito.letti += 1

    let risposta: { stato: number; corpo: unknown }
    try {
      risposta = await chiediTracking(urlTrackingReso(cfg.data.endpoint, r.tracking_parcel_id), credenziali)
      erroriDiFila = 0
    } catch (errore) {
      esito.errori += 1
      erroriDiFila += 1
      const messaggio = errore instanceof Error ? errore.message : String(errore)
      log.warn({ err: messaggio }, 'lettura tracking reso BRT fallita')
      await db`update etichetta_reso set tracking_errore = ${messaggio.slice(0, 300)}, updated_at = now() where id = ${r.id}`
      if (erroriDiFila >= ERRORI_DI_FILA_MASSIMI) {
        esito.interrotto = true
        break
      }
      continue
    }

    try {
      // Credenziali non abilitate al tracking, o servizio giù: si vede nel
      // riquadro e nel log, e il giro si ferma (inutile riprovare le altre).
      if (risposta.stato === 401 || risposta.stato === 403 || risposta.stato >= 500) {
        esito.errori += 1
        esito.interrotto = true
        const messaggio = `BRT ha risposto ${risposta.stato} al tracking del reso`
        await db`update etichetta_reso set tracking_errore = ${messaggio}, updated_at = now() where id = ${r.id}`
        log.warn({ http: risposta.stato }, messaggio)
        break
      }

      const lettura: EsitoLettura =
        risposta.stato === 404
          ? { riconosciuta: true, trovata: false }
          : leggiRisposta(risposta.corpo)

      if (!lettura.riconosciuta) {
        esito.non_riconosciuti += 1
        // Un pezzo della risposta (non contiene credenziali né dati del cliente)
        // per capire in cosa differisce da quella attesa.
        nonRiconosciuti.push({ id: r.id, motivo: lettura.motivo, http: risposta.stato, risposta: JSON.stringify(risposta.corpo)?.slice(0, 1500) ?? null })
        await db`update etichetta_reso set tracking_errore = ${lettura.motivo.slice(0, 300)}, tracking_letto_at = now(), updated_at = now() where id = ${r.id}`
        continue
      }

      if (!lettura.trovata) {
        esito.in_attesa += 1
        await db`
          update etichetta_reso set
            spedizione_stato = coalesce(spedizione_stato, 'in_attesa'),
            tracking_letto_at = now(), tracking_errore = null, updated_at = now()
          where id = ${r.id}
        `
        continue
      }

      const ultimo = lettura.eventi[0]!
      const consegnato = lettura.stato === 'consegnato'
      await db`
        update etichetta_reso set
          spedizione_stato          = ${lettura.stato},
          spedizione_eventi         = ${db.json(lettura.eventi as unknown as Parameters<typeof db.json>[0])},
          spedizione_ultimo_evento  = ${ultimo.evento},
          spedizione_consegnata_at  = ${consegnato ? `${ultimo.data}T${ultimo.ora ?? '00:00'}:00+01:00` : null}::timestamptz,
          spedizione_aggiornata_at  = now(),
          tracking_letto_at         = now(),
          tracking_errore           = null,
          updated_at                = now()
        where id = ${r.id}
      `
      esito.aggiornati += 1
    } catch (errore) {
      esito.errori += 1
      log.error({ etichetta_id: r.id, err: errore instanceof Error ? errore.message : String(errore) }, 'scrittura tracking reso fallita')
    }
  }

  if (nonRiconosciuti.length > 0) {
    await db`
      insert into ingest_anomaly (tipo, payload)
      values ('brt_tracking_reso_non_riconosciuto', ${db.json({ quante: nonRiconosciuti.length, esempi: nonRiconosciuti.slice(0, 5) })})
    `
  }
  return esito
}
