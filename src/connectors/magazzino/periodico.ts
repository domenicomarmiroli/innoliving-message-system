import type { Config } from '../../config.js'
import type { Db } from '../../db/index.js'
import type { Logger } from '../../logger.js'
import { recuperaRientri, elaboraRientri } from './rientri.js'

/**
 * Il giro periodico che controlla i rientri in magazzino.
 *
 * Stesso schema di connectors/shopify/periodico.ts: gira dentro il
 * servizio già acceso, non in un cron esterno. Nessun canale critico in
 * tempo reale — un pacco arrivato mezz'ora fa può aspettare mezz'ora in
 * più prima che il ticket si riapra.
 */

const PRIMO_GIRO_MS = 60_000

export interface CicloRientri {
  ferma(): void
}

export function avviaControlloRientri(
  db: Db,
  log: Logger,
  config: Config,
): CicloRientri | null {
  if (!config.MAGAZZINO_API_URL || !config.MAGAZZINO_API_TOKEN) {
    log.warn(
      {},
      'MAGAZZINO_API_URL/MAGAZZINO_API_TOKEN non configurati: controllo rientri magazzino non avviato',
    )
    return null
  }

  const intervallo = config.MAGAZZINO_SYNC_MINUTES * 60_000
  let fermato = false
  let timer: NodeJS.Timeout | null = setTimeout(() => void giro(), PRIMO_GIRO_MS)

  async function giro(): Promise<void> {
    if (fermato) return
    try {
      const rientri = await recuperaRientri(config)
      const esito = await elaboraRientri(db, log, rientri)
      if (esito.agganciati > 0) {
        log.info(esito, 'rientri magazzino controllati')
      }
    } catch (errore) {
      // Un fallimento qui non deve fermare il ciclo: la rete cade, il
      // tool di magazzino è in manutenzione. Si riprova al giro dopo.
      log.error(
        { err: errore instanceof Error ? errore.message : String(errore) },
        'controllo rientri magazzino fallito',
      )
    } finally {
      if (!fermato) timer = setTimeout(() => void giro(), intervallo)
    }
  }

  log.info(
    { ogni_minuti: config.MAGAZZINO_SYNC_MINUTES },
    'controllo periodico dei rientri in magazzino avviato',
  )

  return {
    ferma() {
      fermato = true
      if (timer) clearTimeout(timer)
    },
  }
}
