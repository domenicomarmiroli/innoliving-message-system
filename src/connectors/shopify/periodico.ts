import type { Config } from '../../config.js'
import type { Db } from '../../db/index.js'
import type { Logger } from '../../logger.js'
import { sincronizzaOrdiniShopify } from './incrementale.js'

/**
 * Il giro periodico che riallinea gli ordini.
 *
 * Gira dentro il servizio, non in un cron esterno: il processo è già
 * sempre acceso per leggere la casella, quindi un secondo servizio
 * sarebbe un pezzo in più da configurare, pagare e sorvegliare per fare
 * una cosa che questo può fare da solo.
 *
 * Il primo giro parte dopo un minuto e non subito: all'avvio il servizio
 * ha già da fare, e un ordine in più fra sessanta secondi non cambia
 * niente.
 */

const PRIMO_GIRO_MS = 60_000

export interface CicloOrdini {
  ferma(): void
}

export function avviaAllineamentoOrdini(
  db: Db,
  log: Logger,
  config: Config,
): CicloOrdini | null {
  if (!config.SHOPIFY_SHOP) {
    log.warn({}, 'SHOPIFY_SHOP non configurato: allineamento ordini non avviato')
    return null
  }

  const intervallo = config.SHOPIFY_SYNC_MINUTES * 60_000
  let fermato = false
  let timer: NodeJS.Timeout | null = setTimeout(() => void giro(), PRIMO_GIRO_MS)

  async function giro(): Promise<void> {
    if (fermato) return
    try {
      const esito = await sincronizzaOrdiniShopify(db, log, config)
      if (esito.ordini > 0) {
        log.info(esito, 'ordini Shopify riallineati')
      }
    } catch (errore) {
      // Un fallimento qui non deve fermare il ciclo: la rete cade,
      // Shopify limita, il token scade. Si riprova al giro dopo.
      log.error(
        { err: errore instanceof Error ? errore.message : String(errore) },
        'allineamento ordini fallito',
      )
    } finally {
      if (!fermato) timer = setTimeout(() => void giro(), intervallo)
    }
  }

  log.info(
    { ogni_minuti: config.SHOPIFY_SYNC_MINUTES },
    'allineamento periodico degli ordini avviato',
  )

  return {
    ferma() {
      fermato = true
      if (timer) clearTimeout(timer)
    },
  }
}
