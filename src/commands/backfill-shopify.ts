import { loadConfig } from '../config.js'
import { createDb } from '../db/index.js'
import { logger } from '../logger.js'
import { backfillShopify } from '../connectors/shopify/backfill.js'

/** npm run backfill:shopify -- --since=2026-01-01 */
const since = process.argv.find((a) => a.startsWith('--since='))?.split('=')[1]

const config = loadConfig()
const db = createDb(config)

try {
  const esito = await backfillShopify(db, logger, config, since ? { since } : {})
  logger.info(esito, 'backfill completato')
} catch (err) {
  logger.error({ err }, 'backfill fallito')
  process.exitCode = 1
} finally {
  await db.end({ timeout: 5 })
}
