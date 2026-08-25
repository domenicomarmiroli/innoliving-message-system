import type { FastifyInstance } from 'fastify'

import type { Config } from '../config.js'
import type { Db } from '../db/index.js'
import { verificaFirma } from '../connectors/shopify/hmac.js'
import { daWebhook } from '../connectors/shopify/normalize.js'
import { upsertOrdine } from '../connectors/shopify/upsert.js'

/**
 * Webhook Shopify: orders/create, orders/updated, fulfillments/create.
 *
 * Due regole che vengono da come Shopify si comporta davvero:
 *  1. si risponde 200 SUBITO e si elabora dopo. Shopify considera fallito un
 *     webhook che tarda più di 5 secondi e lo ritenta, moltiplicando il
 *     lavoro proprio quando il sistema è già lento;
 *  2. la firma si verifica sul corpo grezzo, prima di qualunque analisi.
 */
export async function shopifyWebhookRoutes(
  app: FastifyInstance,
  opts: { db: Db; config: Config },
) {
  const { db, config } = opts

  // Conserva il corpo grezzo: senza, la firma non torna mai.
  app.addContentTypeParser(
    'application/json',
    { parseAs: 'buffer' },
    (req, body, done) => {
      ;(req as { rawBody?: Buffer }).rawBody = body as Buffer
      try {
        done(null, JSON.parse((body as Buffer).toString('utf8')))
      } catch (err) {
        done(err as Error, undefined)
      }
    },
  )

  app.post('/webhooks/shopify', async (req, reply) => {
    const segreto = config.SHOPIFY_WEBHOOK_SECRET
    if (!segreto) {
      req.log.error('webhook Shopify ricevuto ma SHOPIFY_WEBHOOK_SECRET non è configurato')
      return reply.code(503).send({ errore: 'connettore non configurato' })
    }

    const grezzo = (req as { rawBody?: Buffer }).rawBody
    const firma = req.headers['x-shopify-hmac-sha256']
    if (!grezzo || !verificaFirma(grezzo, typeof firma === 'string' ? firma : undefined, segreto)) {
      req.log.warn({ topic: req.headers['x-shopify-topic'] }, 'firma del webhook non valida')
      return reply.code(401).send({ errore: 'firma non valida' })
    }

    const topic = String(req.headers['x-shopify-topic'] ?? '')
    const payload = req.body as Record<string, unknown>

    // Risposta immediata, elaborazione dopo.
    void reply.code(200).send({ ok: true })

    setImmediate(() => {
      void (async () => {
        try {
          // fulfillments/create porta la spedizione, non l'ordine intero:
          // il campo order_id rimanda all'ordine da rileggere.
          if (topic.startsWith('fulfillments/')) {
            req.log.info({ topic }, 'evasione ricevuta: rilettura dell ordine rimandata al backfill')
            return
          }
          const ordine = daWebhook(payload)
          const esito = await upsertOrdine(db, req.log, ordine)
          req.log.info(
            { topic, canale: ordine.channel, ordine: ordine.external_order_id, esito: esito.esito },
            'ordine sincronizzato',
          )
        } catch (err) {
          req.log.error({ err, topic }, 'elaborazione del webhook fallita')
          try {
            await db`
              insert into ingest_anomaly (tipo, payload)
              values ('webhook_shopify_fallito', ${db.json({
                topic,
                errore: err instanceof Error ? err.message : String(err),
                payload,
              } as never)})
            `
          } catch (err2) {
            req.log.error({ err: err2 }, 'impossibile registrare l anomalia')
          }
        }
      })()
    })
  })
}
