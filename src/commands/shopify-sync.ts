/**
 * Un giro di allineamento ordini, a mano.
 *
 *   npm run shopify:sync
 *   npm run shopify:sync -- --creati-dal 2025-10-01
 *
 * Senza argomenti è lo stesso giro che il servizio fa da solo ogni ora.
 * Con `--creati-dal` ripassa tutti gli ordini creati da quella data, anche
 * se non sono cambiati: serve dopo aver aggiunto un campo alla query
 * (indirizzi, email), per completare gli ordini già in archivio. Non
 * tocca il segnalibro del giro periodico.
 */
import { loadConfig } from '../config.js'
import { createDb } from '../db/index.js'
import { logger } from '../logger.js'
import { sincronizzaOrdiniShopify } from '../connectors/shopify/incrementale.js'

function argomento(nome: string): string | undefined {
  const i = process.argv.indexOf(nome)
  return i >= 0 ? process.argv[i + 1] : undefined
}

const creatiDal = argomento('--creati-dal')
if (creatiDal !== undefined && !/^\d{4}-\d{2}-\d{2}$/.test(creatiDal)) {
  console.error('--creati-dal vuole una data nella forma AAAA-MM-GG, es. 2025-10-01')
  process.exit(1)
}

const config = loadConfig()
const db = createDb(config)

try {
  const esito = await sincronizzaOrdiniShopify(
    db,
    logger,
    config,
    creatiDal ? { creatiDal, pagineMax: 1000 } : {},
  )
  console.log('')
  console.log(creatiDal ? '  creati dal: ' : '  guardo da:  ', esito.da)
  console.log('  ordini:     ', esito.ordini)
  console.log('  pagine:     ', esito.pagine)
  console.log('  anomalie:   ', esito.anomalie)
  console.log('')
} finally {
  await db.end({ timeout: 5 })
}
