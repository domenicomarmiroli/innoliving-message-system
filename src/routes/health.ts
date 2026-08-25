import type { FastifyInstance } from 'fastify'
import type { Db } from '../db/index.js'

export async function healthRoutes(app: FastifyInstance, opts: { db: Db }) {
  app.get('/health', async (_req, reply) => {
    const start = performance.now()
    try {
      await opts.db`select 1 as ok`
      return reply.code(200).send({
        status: 'ok',
        db_ms: Math.round(performance.now() - start),
      })
    } catch (err) {
      app.log.error({ err }, 'health: database irraggiungibile')
      return reply.code(503).send({
        status: 'degraded',
        error: err instanceof Error ? err.message : 'errore sconosciuto',
      })
    }
  })
}
