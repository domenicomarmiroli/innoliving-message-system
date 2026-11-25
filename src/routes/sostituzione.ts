import { timingSafeEqual } from 'node:crypto'
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import { z } from 'zod'

import type { Config } from '../config.js'
import type { Db } from '../db/index.js'
import { verificaAgente } from '../core/agente.js'
import { schemaIndirizzo } from '../core/sostituzione.js'
import {
  creaCodiceScontoSostitutivo,
  creaOrdineSostitutivo,
  ErroreSostituzione,
  statoSostituzione,
} from '../connectors/shopify/sostituzione.js'

/**
 * Prodotto sostitutivo in garanzia, dal ticket (migrazione 0055).
 *
 * GET  /threads/:id/sostitutivo            cosa fare: prodotto, disponibilità,
 *                                           indirizzo del portale, valore scontrino
 * POST /threads/sostitutivo/ordine         { thread_id, indirizzo?, email?, variant_gid? }
 * POST /threads/sostitutivo/codice-sconto  { thread_id }
 *
 * Solo rotte di servizio: la schermata sta in Lovable (regola del 06/11).
 */

function confrontoCostante(a: string, b: string): boolean {
  const ba = Buffer.from(a)
  const bb = Buffer.from(b)
  return ba.length === bb.length && timingSafeEqual(ba, bb)
}

export async function sostituzioneRoutes(app: FastifyInstance, opts: { db: Db; config: Config }) {
  const { db, config } = opts
  if (!config.WORKER_API_TOKEN && !(config.SUPABASE_URL && config.SUPABASE_ANON_KEY)) return

  async function chiChiama(req: FastifyRequest): Promise<string | null | undefined> {
    const h = req.headers['x-worker-token']
    const token = Array.isArray(h) ? h[0] : h
    if (config.WORKER_API_TOKEN && token && confrontoCostante(token, config.WORKER_API_TOKEN)) return null
    const auth = req.headers.authorization
    const sessione = auth?.startsWith('Bearer ') ? auth.slice(7) : null
    const agente = sessione ? await verificaAgente(db, config, sessione) : null
    return agente ? agente.id : undefined
  }

  function errore(reply: FastifyReply, req: FastifyRequest, e: unknown) {
    if (e instanceof ErroreSostituzione) return reply.code(e.status).send({ errore: e.message, codice: e.codice ?? null })
    req.log.error({ err: e }, 'sostitutivo non creato')
    return reply.code(500).send({ errore: 'errore interno' })
  }

  app.get('/threads/:id/sostitutivo', async (req, reply) => {
    if ((await chiChiama(req)) === undefined) return reply.code(401).send({ errore: 'non autorizzato' })
    const { id } = req.params as { id: string }
    if (!z.string().uuid().safeParse(id).success) return reply.code(400).send({ errore: 'id non valido' })
    try {
      return reply.send(await statoSostituzione(db, config, req.log, id))
    } catch (e) {
      return errore(reply, req, e)
    }
  })

  const corpoOrdine = z.object({
    thread_id: z.string().uuid(),
    indirizzo: schemaIndirizzo.nullable().optional(),
    email: z.string().email().nullable().optional(),
    variant_gid: z.string().max(200).nullable().optional(),
  })

  app.post('/threads/sostitutivo/ordine', async (req, reply) => {
    const agente = await chiChiama(req)
    if (agente === undefined) return reply.code(401).send({ errore: 'non autorizzato' })
    const c = corpoOrdine.safeParse(req.body)
    if (!c.success) {
      return reply.code(400).send({ errore: c.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ') })
    }
    try {
      return reply.send(await creaOrdineSostitutivo(db, config, req.log, { ...c.data, agent_id: agente }))
    } catch (e) {
      return errore(reply, req, e)
    }
  })

  const corpoSconto = z.object({ thread_id: z.string().uuid() })

  app.post('/threads/sostitutivo/codice-sconto', async (req, reply) => {
    const agente = await chiChiama(req)
    if (agente === undefined) return reply.code(401).send({ errore: 'non autorizzato' })
    const c = corpoSconto.safeParse(req.body)
    if (!c.success) return reply.code(400).send({ errore: 'thread_id non valido' })
    try {
      return reply.send(await creaCodiceScontoSostitutivo(db, config, req.log, { ...c.data, agent_id: agente }))
    } catch (e) {
      return errore(reply, req, e)
    }
  })
}
