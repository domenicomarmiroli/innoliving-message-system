import { timingSafeEqual } from 'node:crypto'
import type { FastifyInstance, FastifyRequest } from 'fastify'
import { z } from 'zod'

import type { Config } from '../config.js'
import type { Db } from '../db/index.js'
import { verificaAgente } from '../core/agente.js'
import { STATI_OPERATORE } from '../core/pratica/stati.js'
import { registraStatoPratica } from '../connectors/pratica/avvisi.js'

/**
 * Stato della pratica dall'interfaccia (migrazione 0044).
 *
 *   GET  /threads/:id/pratica      stato attuale ed eventi con l'esito dell'avviso
 *   POST /threads/stato-pratica    { thread_id, stato, tracking?, corriere? }
 *
 * L'operatore imposta solo gli stati che il sistema non può sapere da
 * solo: etichetta inviata, prodotto spedito, pratica chiusa. "ricevuta" e
 * i rientri li registra il worker. Stessa autenticazione di /threads/reply.
 */

function confrontoCostante(a: string, b: string): boolean {
  const ba = Buffer.from(a)
  const bb = Buffer.from(b)
  return ba.length === bb.length && timingSafeEqual(ba, bb)
}

const corpo = z
  .object({
    thread_id: z.string().uuid(),
    stato: z.enum(STATI_OPERATORE),
    tracking: z.string().trim().min(4).max(60).nullable().optional(),
    corriere: z.string().trim().max(60).nullable().optional(),
  })
  .refine((c) => c.stato !== 'spedita' || !!c.tracking, { message: 'per "spedita" serve il numero di tracciamento', path: ['tracking'] })

export async function praticaRoutes(app: FastifyInstance, opts: { db: Db; config: Config }) {
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

  app.get('/threads/:id/pratica', async (req, reply) => {
    if ((await chiChiama(req)) === undefined) return reply.code(401).send({ errore: 'non autorizzato' })
    const { id } = req.params as { id: string }
    if (!z.string().uuid().safeParse(id).success) return reply.code(400).send({ errore: 'id non valido' })
    const [t] = await db<{ stato_pratica: string | null; stato_pratica_at: Date | null }[]>`
      select stato_pratica, stato_pratica_at from thread where id = ${id}
    `
    if (!t) return reply.code(404).send({ errore: 'ticket inesistente' })
    const eventi = await db`
      select stato, origine, dettagli, avviso, errore, created_at, inviato_at
      from pratica_evento where thread_id = ${id} order by created_at
    `
    return reply.send({ ...t, eventi })
  })

  app.post('/threads/stato-pratica', async (req, reply) => {
    const agente = await chiChiama(req)
    if (agente === undefined) return reply.code(401).send({ errore: 'non autorizzato' })
    const c = corpo.safeParse(req.body)
    if (!c.success) return reply.code(400).send({ errore: c.error.issues.map((i) => i.message).join('; ') })
    const [esiste] = await db<{ id: string }[]>`select id from thread where id = ${c.data.thread_id}`
    if (!esiste) return reply.code(404).send({ errore: 'ticket inesistente' })
    const nuovo = await registraStatoPratica(db, {
      thread_id: c.data.thread_id,
      stato: c.data.stato,
      origine: 'operatore',
      dettagli: { tracking: c.data.tracking ?? null, corriere: c.data.corriere ?? null },
      agent_id: agente,
    })
    if (!nuovo) return reply.code(409).send({ errore: 'questo stato è già stato registrato per la pratica' })
    return reply.send({ ok: true })
  })
}
