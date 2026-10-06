import type { Config } from '../../config.js'
import type { Db } from '../../db/index.js'
import type { Logger } from '../../logger.js'
import { estraiNumeroOrdineDaRiferimento } from './rientri.js'

/**
 * Tracking degli ordini Amazon, da Zoho.
 *
 * Gli ordini Amazon arrivano su Shopify tramite Marketplace Connect con
 * `trackingInfo: []`: verificato sui dati (06/10), 2.041 ordini Amazon su
 * 2.041 degli ultimi 30 giorni senza tracking, e tutti i ticket aperti in
 * quel periodo erano su ordini Amazon. La spedizione la crea il gestionale
 * Zoho, nel *pacchetto* dell'ordine di vendita `AMZS<numero Amazon>`
 * (vettore + numero di spedizione a 12 cifre per BRT).
 *
 * Il worker non parla con Zoho: lo fa "Utilities Magazzino", che ha già
 * l'autenticazione Zoho e espone `GET /api/public/spedizioni` accanto a
 * `/rientri`, con lo stesso token. Stessa scelta dei rientri: nessuna
 * credenziale Zoho in più da tenere qui.
 */

export interface SpedizioneZoho {
  salesorder_number: string | null
  package_number: string | null
  carrier: string | null
  tracking_number: string | null
  shipment_date: string | null
  status: string | null
}

export type StatoSpedizione = 'non_spedito' | 'spedito' | 'consegnato'

export interface AggiornamentoTracking {
  numero_ordine: string
  tracking_number: string
  carrier: string | null
  tracking_url: string | null
  stato: StatoSpedizione | null
  data_spedizione: string | null
}

/**
 * Lo stato del pacchetto Zoho. Valori visti sui dati veri (06/10):
 * `not_shipped`, `shipped`, `delivered`. Un valore nuovo resta null —
 * meglio nessuno stato che uno sbagliato detto a un cliente al telefono.
 */
export function statoDaZoho(status: string | null): StatoSpedizione | null {
  switch (status?.trim().toLowerCase()) {
    case 'not_shipped':
      return 'non_spedito'
    case 'shipped':
      return 'spedito'
    case 'delivered':
      return 'consegnato'
    default:
      return null
  }
}

/**
 * La pagina pubblica di tracciamento del corriere, quando la conosciamo.
 *
 * Per BRT verificato (06/10) che la pagina accetta il numero di spedizione
 * a 12 cifre, l'unico che abbiamo: l'API REST di BRT invece vuole il
 * segnacollo, che esiste solo alla creazione della spedizione. Un
 * corriere sconosciuto resta senza link: meglio nessun link che uno
 * costruito a indovinare.
 */
export function linkTracciamento(carrier: string | null, numero: string): string | null {
  const c = carrier?.trim().toLowerCase() ?? ''
  if (/^brt\b|bartolini/.test(c)) {
    return `https://vas.brt.it/vas/sped_det_show.hsm?referer=sped_numspe_par.htm&Nspediz=${encodeURIComponent(numero)}`
  }
  return null
}

/**
 * Dalle spedizioni Zoho agli aggiornamenti da scrivere: solo ordini Amazon
 * (prefisso `AMZS` + forma esatta del numero), solo con un tracking. Più
 * pacchetti per lo stesso ordine: vince il più recente per data di
 * spedizione — il numero che il cliente ha in mano è quello dell'ultimo
 * invio, per esempio dopo una sostituzione.
 */
export function aggiornamentiDaSpedizioni(spedizioni: SpedizioneZoho[]): AggiornamentoTracking[] {
  const perOrdine = new Map<string, { agg: AggiornamentoTracking; data: string }>()
  for (const s of spedizioni) {
    const numero = estraiNumeroOrdineDaRiferimento(s.salesorder_number)
    const tracking = s.tracking_number?.replace(/\s+/g, '') ?? ''
    if (!numero || !tracking) continue
    const carrier = s.carrier?.trim() || null
    const data = s.shipment_date ?? ''
    const precedente = perOrdine.get(numero)
    if (precedente && precedente.data > data) continue
    perOrdine.set(numero, {
      agg: {
        numero_ordine: numero,
        tracking_number: tracking,
        carrier,
        tracking_url: linkTracciamento(carrier, tracking),
        stato: statoDaZoho(s.status),
        data_spedizione: /^\d{4}-\d{2}-\d{2}$/.test(data) ? data : null,
      },
      data,
    })
  }
  return [...perOrdine.values()].map((x) => x.agg)
}

/** Quanti giorni indietro rileggere a ogni giro: nessun segnalibro fra i due database. */
const GIORNI_FINESTRA = 30

export async function recuperaSpedizioni(config: Config): Promise<SpedizioneZoho[]> {
  if (!config.MAGAZZINO_API_URL || !config.MAGAZZINO_API_TOKEN) {
    throw new Error('Spedizioni Zoho non configurate: mancano MAGAZZINO_API_URL e/o MAGAZZINO_API_TOKEN.')
  }
  // Stesso tool, rotta accanto: …/api/public/rientri → …/api/public/spedizioni.
  const url = new URL('spedizioni', config.MAGAZZINO_API_URL)
  url.searchParams.set('since', new Date(Date.now() - GIORNI_FINESTRA * 86_400_000).toISOString())

  const risposta = await fetch(url, {
    headers: { Authorization: `Bearer ${config.MAGAZZINO_API_TOKEN}` },
  })
  if (!risposta.ok) {
    const testo = await risposta.text().catch(() => '')
    throw new Error(`Lettura spedizioni Zoho fallita (${risposta.status}): ${testo.slice(0, 300)}`)
  }
  const corpo = (await risposta.json()) as { spedizioni?: SpedizioneZoho[] }
  return corpo.spedizioni ?? []
}

export interface EsitoSpedizioni {
  ricevute: number
  aggiornati: number
  errori: number
}

/**
 * Scrive il tracking sull'ordine Amazon. Idempotente: aggiorna solo se il
 * numero è cambiato, quindi rileggere la stessa finestra a ogni giro non
 * tocca niente. Un ordine non ancora in archivio si salta: al giro dopo,
 * se nel frattempo è arrivato da Shopify, la finestra lo ricomprende.
 * L'upsert Shopify fa `coalesce` sul tracking, quindi non cancella questo.
 */
export async function elaboraSpedizioni(
  db: Db,
  log: Logger,
  spedizioni: SpedizioneZoho[],
): Promise<EsitoSpedizioni> {
  const esito: EsitoSpedizioni = { ricevute: spedizioni.length, aggiornati: 0, errori: 0 }
  for (const a of aggiornamentiDaSpedizioni(spedizioni)) {
    try {
      const righe = await db`
        update "order" set
          tracking_number = ${a.tracking_number},
          carrier         = coalesce(${a.carrier}, carrier),
          tracking_url    = coalesce(${a.tracking_url}, tracking_url),
          -- Zoho conosce solo spedito/consegnato: non deve coprire uno
          -- stato più fine già letto da BRT (in consegna, giacenza...).
          spedizione_stato = case
            when ${a.stato}::text = 'consegnato'
              or spedizione_stato is null
              or spedizione_stato in ('non_spedito', 'spedito')
            then coalesce(${a.stato}, spedizione_stato)
            else spedizione_stato
          end,
          spedizione_data  = coalesce(${a.data_spedizione}::date, spedizione_data),
          spedizione_aggiornata_at = now(),
          updated_at      = now()
        where channel = 'amazon'
          and external_order_id = ${a.numero_ordine}
          and (tracking_number is distinct from ${a.tracking_number}
               or (${a.stato}::text is not null and spedizione_stato is distinct from ${a.stato}
                   and (${a.stato}::text = 'consegnato' or spedizione_stato is null
                        or spedizione_stato in ('non_spedito', 'spedito'))))
      `
      esito.aggiornati += righe.count
    } catch (errore) {
      esito.errori += 1
      log.error(
        { ordine: a.numero_ordine, err: errore instanceof Error ? errore.message : String(errore) },
        'scrittura del tracking Zoho fallita',
      )
    }
  }
  return esito
}
