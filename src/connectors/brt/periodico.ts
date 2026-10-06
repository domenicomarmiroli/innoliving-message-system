import type { Config } from '../../config.js'
import type { Db } from '../../db/index.js'
import type { Logger } from '../../logger.js'
import { giroTrackingBrt } from './tracking.js'

/**
 * Ogni ora si cercano le spedizioni da rileggere; ognuna viene riletta solo
 * ogni `BRT_TRACKING_ORE`, quindi un giro senza niente da fare non fa
 * nessuna richiesta a BRT. Il giro successivo parte solo quando il
 * precedente è finito: con la pausa fra le pagine un giro pieno dura
 * diversi minuti e due giri sovrapposti raddoppierebbero il ritmo.
 */

const PRIMO_GIRO_MS = 2 * 60_000
const INTERVALLO_MS = 60 * 60_000

export function avviaTrackingBrt(db: Db, log: Logger, config: Config): { ferma(): void } | null {
  if (config.BRT_TRACKING_ORE === 0) {
    log.info({}, 'BRT_TRACKING_ORE=0: lettura del tracking BRT spenta')
    return null
  }

  let fermato = false
  let timer: NodeJS.Timeout | null = setTimeout(() => void giro(), PRIMO_GIRO_MS)

  async function giro(): Promise<void> {
    if (fermato) return
    try {
      const esito = await giroTrackingBrt(db, log, config, () => fermato)
      if (esito.letti > 0) log.info(esito, 'tracking BRT letto')
    } catch (errore) {
      log.error(
        { err: errore instanceof Error ? errore.message : String(errore) },
        'giro del tracking BRT fallito',
      )
    } finally {
      if (!fermato) timer = setTimeout(() => void giro(), INTERVALLO_MS)
    }
  }

  log.info(
    { ogni_ore: config.BRT_TRACKING_ORE, pausa_ms: config.BRT_TRACKING_PAUSA_MS },
    'lettura periodica del tracking BRT avviata',
  )
  return {
    ferma() {
      fermato = true
      if (timer) clearTimeout(timer)
    },
  }
}
