import { timingSafeEqual } from 'node:crypto'
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import { z } from 'zod'

import type { Config } from '../config.js'
import type { Db } from '../db/index.js'
import { verificaAgente } from '../core/agente.js'
import { messaggioErrore } from '../connectors/mail/imap.js'
import { anteprimaPartner, ErrorePartner, inviaAlPartner } from '../connectors/mail/assistenza-partner.js'
import { registraInvioFallito } from '../connectors/stato/invio-fallito.js'

/**
 * Richiesta al centro assistenza esterno dal ticket di garanzia (migrazione 0058).
 *
 * GET  /threads/:id/assistenza-partner   anteprima: destinatario, oggetto, testo,
 *                                         allegati, e se è già stata inviata
 * POST /threads/assistenza-partner       { thread_id, nota?, reinvia? }
 *
 * Solo rotte di servizio: il pulsante sta in Lovable (regola del 06/11).
 */

const corpo = z.object({
  thread_id: z.string().uuid(),
  nota: z.string().trim().max(5_000).nullable().optional(),
  reinvia: z.boolean().optional(),
})

function confrontoCostante(a: string, b: string): boolean {
  const ba = Buffer.from(a)
  const bb = Buffer.from(b)
  return ba.length === bb.length && timingSafeEqual(ba, bb)
}

export async function assistenzaPartnerRoutes(app: FastifyInstance, opts: { db: Db; config: Config }) {
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

  function errore(reply: FastifyReply, e: unknown) {
    if (e instanceof ErrorePartner) return reply.code(e.status).send({ errore: e.message })
    return reply.code(502).send({ errore: messaggioErrore(e) })
  }

  app.get('/threads/:id/assistenza-partner', async (req, reply) => {
    if ((await chiChiama(req)) === undefined) return reply.code(401).send({ errore: 'non autorizzato' })
    const { id } = req.params as { id: string }
    if (!z.string().uuid().safeParse(id).success) return reply.code(400).send({ errore: 'id non valido' })
    const { nota } = req.query as { nota?: string }
    try {
      return reply.send(await anteprimaPartner(db, id, nota?.slice(0, 5_000) || null))
    } catch (e) {
      req.log.error({ err: messaggioErrore(e) }, 'anteprima richiesta centro assistenza fallita')
      return errore(reply, e)
    }
  })

  app.post('/threads/assistenza-partner', async (req, reply) => {
    const agente = await chiChiama(req)
    if (agente === undefined) return reply.code(401).send({ errore: 'non autorizzato' })
    const analizzato = corpo.safeParse(req.body)
    if (!analizzato.success) {
      return reply.code(400).send({
        errore: 'richiesta non valida',
        dettagli: analizzato.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`),
      })
    }
    const d = analizzato.data
    try {
      const esito = await inviaAlPartner(db, req.log, config, {
        thread_id: d.thread_id,
        agent_id: agente,
        nota: d.nota ?? null,
        reinvia: d.reinvia ?? false,
      })
      return reply.send(esito)
    } catch (e) {
      if (e instanceof ErrorePartner) return errore(reply, e)
      req.log.error({ thread_id: d.thread_id, err: messaggioErrore(e) }, 'richiesta al centro assistenza non inviata')
      await registraInvioFallito(db, req.log, {
        thread_id: d.thread_id,
        agent_id: agente,
        testo: d.nota ?? 'richiesta al centro assistenza',
        errore: e,
        azione: 'richiesta al centro assistenza',
      })
      return errore(reply, e)
    }
  })
}
