import Fastify from 'fastify'
import { randomUUID } from 'node:crypto'
import type { Config } from './config.js'
import { logger } from './logger.js'
import { createDb } from './db/index.js'
import { healthRoutes } from './routes/health.js'
import { replyRoutes } from './routes/reply.js'
import { shopifyWebhookRoutes } from './routes/webhooks-shopify.js'
import { avviaPolling } from './connectors/mail/poll.js'

export async function buildServer(config: Config) {
  const app = Fastify({
    loggerInstance: logger,
    genReqId: () => randomUUID(),
    // I webhook di Shopify richiedono il corpo grezzo per la verifica HMAC.
    bodyLimit: 8 * 1024 * 1024,
  })

  const db = createDb(config)
  await app.register(healthRoutes, { db })
  await app.register(shopifyWebhookRoutes, { db, config })
  await app.register(replyRoutes, { db, config })

  // La casella si legge chiedendo, non aspettando: IMAP non ha notifiche.
  // Se le credenziali mancano il ciclo non parte e il resto funziona
  // lo stesso — il worker non deve morire perché manca un pezzo.
  const casella = avviaPolling(db, logger, config)

  app.addHook('onClose', async () => {
    casella?.ferma()
    await db.end({ timeout: 5 })
  })

  return app
}
