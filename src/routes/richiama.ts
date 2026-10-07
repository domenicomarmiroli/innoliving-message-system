import { timingSafeEqual } from 'node:crypto'
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import { z } from 'zod'

import type { Config } from '../config.js'
import type { Db } from '../db/index.js'
import { verificaAgente } from '../core/agente.js'
import {
  RichiamataNonValida,
  annullaRichiamata,
  creaRichiamata,
  numeriSuggeriti,
  richiamataConfigurata,
} from '../connectors/voce/richiamate.js'

/**
 * Rotte della richiamata, per l'interfaccia (sessione dell'operatore) o
 * per un'automazione (WORKER_API_TOKEN), come `/threads/reply`.
 *
 *   GET  /threads/:id/richiamata          numeri suggeriti e richiamate del ticket
 *   POST /threads/richiama                { thread_id, numero, messaggio }
 *   POST /threads/richiama/annulla        { thread_id, richiamata_id }
 *
 * Senza la configurazione ElevenLabs le rotte non esistono: un pulsante
 * che non può telefonare non deve sembrare funzionante.
 */

function confrontoCostante(a: string, b: string): boolean {
  const ba = Buffer.from(a)
  const bb = Buffer.from(b)
  return ba.length === bb.length && timingSafeEqual(ba, bb)
}

const corpoRichiama = z.object({
  thread_id: z.string().uuid(),
  numero: z.string().trim().min(6).max(30),
  messaggio: z.string().trim().min(5).max(1500),
})

const corpoAnnulla = z.object({
  thread_id: z.string().uuid(),
  richiamata_id: z.string().uuid(),
})

export async function richiamaRoutes(app: FastifyInstance, opts: { db: Db; config: Config }) {
  const { db, config } = opts
  if (!richiamataConfigurata(config)) return
  if (!config.WORKER_API_TOKEN && !(config.SUPABASE_URL && config.SUPABASE_ANON_KEY)) return

  /** L'agente che chiama, null per un'automazione col token; undefined = non autorizzato. */
  async function chiChiama(req: FastifyRequest): Promise<string | null | undefined> {
    const h = req.headers['x-worker-token']
    const token = Array.isArray(h) ? h[0] : h
    if (config.WORKER_API_TOKEN && token && confrontoCostante(token, config.WORKER_API_TOKEN)) return null
    const auth = req.headers.authorization
    const sessione = auth?.startsWith('Bearer ') ? auth.slice(7) : null
    const agente = sessione ? await verificaAgente(db, config, sessione) : null
    return agente ? agente.id : undefined
  }

  const nonValida = (reply: FastifyReply, errore: z.ZodError) =>
    reply.code(400).send({ errore: 'richiesta non valida', dettagli: errore.issues.map((i) => `${i.path.join('.')}: ${i.message}`) })

  app.get('/threads/:id/richiamata', async (req, reply) => {
    if ((await chiChiama(req)) === undefined) return reply.code(401).send({ errore: 'non autorizzato' })
    const { id } = req.params as { id: string }
    if (!z.string().uuid().safeParse(id).success) return reply.code(400).send({ errore: 'id non valido' })
    const [numeri, richiamate] = await Promise.all([
      numeriSuggeriti(db, id),
      db`
        select r.id, r.numero, r.messaggio, r.stato, r.tentativi, r.prossimo_tentativo_at, r.ultimo_esito,
               r.created_at, r.conclusa_at, a.nome as creata_da
        from richiamata r left join agent a on a.id = r.creata_da
        where r.thread_id = ${id}
        order by r.created_at desc
        limit 10
      `,
    ])
    return reply.send({ numeri_suggeriti: numeri, richiamate })
  })

  app.post('/threads/richiama', async (req, reply) => {
    const agente = await chiChiama(req)
    if (agente === undefined) return reply.code(401).send({ errore: 'non autorizzato' })
    const c = corpoRichiama.safeParse(req.body)
    if (!c.success) return nonValida(reply, c.error)
    const [t] = await db<{ id: string }[]>`select id from thread where id = ${c.data.thread_id}`
    if (!t) return reply.code(404).send({ errore: 'ticket inesistente' })
    try {
      const r = await creaRichiamata(db, { ...c.data, agent_id: agente })
      return reply.send({ ok: true, ...r })
    } catch (errore) {
      if (errore instanceof RichiamataNonValida) return reply.code(422).send({ errore: errore.message })
      req.log.error({ err: errore instanceof Error ? errore.message : String(errore) }, 'richiamata non creata')
      return reply.code(500).send({ errore: 'richiamata non creata' })
    }
  })

  app.post('/threads/richiama/annulla', async (req, reply) => {
    if ((await chiChiama(req)) === undefined) return reply.code(401).send({ errore: 'non autorizzato' })
    const c = corpoAnnulla.safeParse(req.body)
    if (!c.success) return nonValida(reply, c.error)
    const fatto = await annullaRichiamata(db, c.data.richiamata_id, c.data.thread_id)
    return reply.code(fatto ? 200 : 409).send(fatto ? { ok: true } : { errore: 'la richiamata è già conclusa' })
  })
}
