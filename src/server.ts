import Fastify from 'fastify'
import { randomUUID } from 'node:crypto'
import type { Config } from './config.js'
import { logger } from './logger.js'
import { createDb } from './db/index.js'
import { healthRoutes } from './routes/health.js'
import { shopifyWebhookRoutes } from './routes/webhooks-shopify.js'

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

  app.addHook('onClose', async () => {
    await db.end({ timeout: 5 })
  })

  return app
}
