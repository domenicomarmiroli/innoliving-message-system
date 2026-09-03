import Fastify from 'fastify'
import cors from '@fastify/cors'
import { randomUUID } from 'node:crypto'
import type { Config } from './config.js'
import { logger } from './logger.js'
import { createDb } from './db/index.js'
import { healthRoutes } from './routes/health.js'
import { replyRoutes } from './routes/reply.js'
import { collegaRoutes } from './routes/collega.js'
import { draftRoutes } from './routes/draft.js'
import { knowledgeRoutes } from './routes/knowledge.js'
import { contattiRoutes } from './routes/contatti.js'
import { shopifyWebhookRoutes } from './routes/webhooks-shopify.js'
import { avviaPolling } from './connectors/mail/poll.js'
import { avviaAllineamentoOrdini } from './connectors/shopify/periodico.js'

export async function buildServer(config: Config) {
  const app = Fastify({
    loggerInstance: logger,
    genReqId: () => randomUUID(),
    // I webhook di Shopify richiedono il corpo grezzo per la verifica HMAC.
    bodyLimit: 8 * 1024 * 1024,
  })

  // Senza questo, il browser di Lovable blocca la richiesta prima ancora
  // che arrivi al server: niente log qui, solo un errore di rete lato
  // interfaccia. Elenco esplicito di origini, mai un jolly — sono
  // rotte che accettano una sessione agente autenticata.
  if (config.INTERFACCIA_ORIGINS) {
    const origini = config.INTERFACCIA_ORIGINS.split(',').map((o) => o.trim()).filter(Boolean)
    await app.register(cors, {
      origin: origini,
      methods: ['GET', 'POST'],
      allowedHeaders: ['Content-Type', 'Authorization', 'X-Worker-Token'],
    })
  } else {
    logger.warn(
      'INTERFACCIA_ORIGINS non impostata: le chiamate dal browser (Lovable) verranno bloccate da CORS',
    )
  }

  const db = createDb(config)
  await app.register(healthRoutes, { db })
  await app.register(shopifyWebhookRoutes, { db, config })
  await app.register(replyRoutes, { db, config })
  await app.register(collegaRoutes, { db, config })
  await app.register(draftRoutes, { db, config })
  await app.register(knowledgeRoutes, { db, config })
  await app.register(contattiRoutes, { db, config })

  // La casella si legge chiedendo, non aspettando: IMAP non ha notifiche.
  // Se le credenziali mancano il ciclo non parte e il resto funziona
  // lo stesso — il worker non deve morire perché manca un pezzo.
  const casella = avviaPolling(db, logger, config)

  // Gli ordini arrivano dai webhook, che sono immediati. Questo giro è
  // la rete sotto: un webhook può perdersi durante un deploy o dopo un
  // 500, e un ordine mancante significa un cliente che scrive di un
  // ordine che per noi non esiste.
  const ordini = avviaAllineamentoOrdini(db, logger, config)

  app.addHook('onClose', async () => {
    casella?.ferma()
    ordini?.ferma()
    await db.end({ timeout: 5 })
  })

  return app
}
