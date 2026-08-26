/**
 * Un giro di allineamento ordini, a mano.
 *
 *   npm run shopify:sync
 *
 * Lo stesso che il servizio fa da solo ogni ora. Serve per non
 * aspettare, dopo aver registrato i webhook o dopo un'interruzione.
 */
import { loadConfig } from '../config.js'
import { createDb } from '../db/index.js'
import { logger } from '../logger.js'
import { sincronizzaOrdiniShopify } from '../connectors/shopify/incrementale.js'

const config = loadConfig()
const db = createDb(config)

try {
  const esito = await sincronizzaOrdiniShopify(db, logger, config)
  console.log('')
  console.log('  guardo da:  ', esito.da)
  console.log('  ordini:     ', esito.ordini)
  console.log('  pagine:     ', esito.pagine)
  console.log('  anomalie:   ', esito.anomalie)
  console.log('')
} finally {
  await db.end({ timeout: 5 })
}
