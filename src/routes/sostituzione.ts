import { timingSafeEqual } from 'node:crypto'
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import { z } from 'zod'

import type { Config } from '../config.js'
import type { Db } from '../db/index.js'
import { verificaAgente } from '../core/agente.js'
import { schemaIndirizzo, schemaIndirizzoPortale } from '../core/sostituzione.js'
import {
  creaCodiceScontoSostitutivo,
  creaOrdineSostitutivo,
  ErroreSostituzione,
  salvaIndirizzo,
  statoSostituzione,
} from '../connectors/shopify/sostituzione.js'

/**
 * Prodotto sostitutivo in garanzia, dal ticket (migrazione 0055).
 *
 * GET  /threads/:id/sostitutivo[?sku=]     cosa fare: prodotto, disponibilità,
 *                                           indirizzo del portale, valore scontrino
 * POST /threads/sostitutivo/ordine         { thread_id, indirizzo?, email?, variant_gid?, sku? }
 * POST /threads/sostitutivo/codice-sconto  { thread_id, sku? }
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
      const { sku } = req.query as { sku?: string }
      return reply.send(await statoSostituzione(db, config, req.log, id, sku?.slice(0, 60) || null))
    } catch (e) {
      return errore(reply, req, e)
    }
  })

  // L'indirizzo scritto dall'operatore resta sul ticket anche se esce senza
  // spedire (2026-11-26, #17204). Tollerante: si può salvare a metà.
  const corpoIndirizzo = z.object({ thread_id: z.string().uuid(), indirizzo: schemaIndirizzoPortale })

  app.post('/threads/sostitutivo/indirizzo', async (req, reply) => {
    if ((await chiChiama(req)) === undefined) return reply.code(401).send({ errore: 'non autorizzato' })
    const c = corpoIndirizzo.safeParse(req.body)
    if (!c.success) {
      return reply.code(400).send({ errore: c.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ') })
    }
    try {
      const ok = await salvaIndirizzo(db, c.data.thread_id, c.data.indirizzo)
      return ok ? reply.send({ ok: true }) : reply.code(404).send({ errore: 'ticket non trovato' })
    } catch (e) {
      return errore(reply, req, e)
    }
  })

  const corpoOrdine = z.object({
    thread_id: z.string().uuid(),
    indirizzo: schemaIndirizzo.nullable().optional(),
    email: z.string().email().nullable().optional(),
    variant_gid: z.string().max(200).nullable().optional(),
    sku: z.string().trim().min(2).max(60).nullable().optional(),
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

  const corpoSconto = z.object({
    thread_id: z.string().uuid(),
    sku: z.string().trim().min(2).max(60).nullable().optional(),
    // Solo se il portale non ha letto il valore dallo scontrino: lo inserisce l'operatore.
    importo: z.number().positive().max(5_000).nullable().optional(),
  })

  app.post('/threads/sostitutivo/codice-sconto', async (req, reply) => {
    const agente = await chiChiama(req)
    if (agente === undefined) return reply.code(401).send({ errore: 'non autorizzato' })
    const c = corpoSconto.safeParse(req.body)
    if (!c.success) return reply.code(400).send({ errore: c.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ') })
    try {
      return reply.send(await creaCodiceScontoSostitutivo(db, config, req.log, { ...c.data, agent_id: agente }))
    } catch (e) {
      return errore(reply, req, e)
    }
  })
}
