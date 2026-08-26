import { timingSafeEqual } from 'node:crypto'
import type { FastifyInstance } from 'fastify'
import { z } from 'zod'

import type { Config } from '../config.js'
import type { Db } from '../db/index.js'
import { verificaAgente } from '../core/agente.js'
import { generaBozza } from '../core/ai/draft.js'

/**
 * Generazione di una proposta di risposta — chiamata dall'interfaccia,
 * stessa autenticazione di /threads/reply (vedi lì per il perché: mai
 * un token statico nel browser, sessione Supabase verificata contro
 * Auth). Non spedisce nulla: scrive solo in ai_draft, per approvazione
 * umana attraverso /threads/reply.
 */

const corpo = z.object({
  thread_id: z.string().uuid(),
})

function confrontoCostante(a: string, b: string): boolean {
  const ba = Buffer.from(a)
  const bb = Buffer.from(b)
  if (ba.length !== bb.length) return false
  return timingSafeEqual(ba, bb)
}

export async function draftRoutes(app: FastifyInstance, opts: { db: Db; config: Config }) {
  const { db, config } = opts

  const worker_token_attivo = Boolean(config.WORKER_API_TOKEN)
  const sessione_attiva = Boolean(config.SUPABASE_URL && config.SUPABASE_ANON_KEY)
  if (!worker_token_attivo && !sessione_attiva) return
  if (!config.ANTHROPIC_API_KEY) {
    app.log.warn('ANTHROPIC_API_KEY non impostata: la rotta delle bozze AI resta disattivata')
    return
  }

  app.post('/threads/draft', async (req, reply) => {
    const headerWorker = req.headers['x-worker-token']
    const tokenWorker = Array.isArray(headerWorker) ? headerWorker[0] : headerWorker
    const worker_ok =
      worker_token_attivo && !!tokenWorker && confrontoCostante(tokenWorker, config.WORKER_API_TOKEN!)

    if (!worker_ok) {
      const headerAuth = req.headers.authorization
      const tokenSessione = headerAuth?.startsWith('Bearer ') ? headerAuth.slice(7) : null
      const agente = tokenSessione && sessione_attiva ? await verificaAgente(db, config, tokenSessione) : null
      if (!agente) return reply.code(401).send({ errore: 'non autorizzato' })
    }

    const analizzato = corpo.safeParse(req.body)
    if (!analizzato.success) {
      return reply.code(400).send({
        errore: 'richiesta non valida',
        dettagli: analizzato.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`),
      })
    }

    try {
      const bozza = await generaBozza(db, req.log, config, analizzato.data.thread_id)
      return reply.code(200).send(bozza)
    } catch (errore) {
      req.log.error(
        { thread_id: analizzato.data.thread_id, err: errore instanceof Error ? errore.message : String(errore) },
        'generazione bozza AI fallita',
      )
      return reply.code(502).send({
        errore: errore instanceof Error ? errore.message : String(errore),
      })
    }
  })
}
