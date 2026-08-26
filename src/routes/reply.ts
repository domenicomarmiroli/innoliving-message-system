import { timingSafeEqual } from 'node:crypto'
import type { FastifyInstance } from 'fastify'
import { z } from 'zod'

import type { Config } from '../config.js'
import type { Db } from '../db/index.js'
import { inviaRisposta } from '../connectors/mail/invia.js'
import { messaggioErrore } from '../connectors/mail/imap.js'

/**
 * Invio di una risposta, chiamato dall'interfaccia.
 *
 * Protetto da un segreto condiviso: questo endpoint spedisce email
 * dall'identità venditore, e lasciarlo aperto significherebbe regalare a
 * chiunque la possibilità di scrivere ai clienti a nome dell'azienda.
 * Senza WORKER_API_TOKEN la rotta non viene registrata affatto.
 */

const corpo = z.object({
  thread_id: z.string().uuid(),
  testo: z.string().min(1).max(20_000),
  agent_id: z.string().uuid().nullable().optional(),
})

function confrontoCostante(a: string, b: string): boolean {
  const ba = Buffer.from(a)
  const bb = Buffer.from(b)
  if (ba.length !== bb.length) return false
  return timingSafeEqual(ba, bb)
}

export async function replyRoutes(
  app: FastifyInstance,
  opts: { db: Db; config: Config },
) {
  const { db, config } = opts

  if (!config.WORKER_API_TOKEN) {
    app.log.warn(
      'WORKER_API_TOKEN non impostato: la rotta di invio risposta resta disattivata',
    )
    return
  }

  const atteso = config.WORKER_API_TOKEN

  app.post('/threads/reply', async (req, reply) => {
    const header = req.headers['x-worker-token']
    const fornito = Array.isArray(header) ? header[0] : header
    if (!fornito || !confrontoCostante(fornito, atteso)) {
      return reply.code(401).send({ errore: 'non autorizzato' })
    }

    const analizzato = corpo.safeParse(req.body)
    if (!analizzato.success) {
      return reply.code(400).send({
        errore: 'richiesta non valida',
        dettagli: analizzato.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`),
      })
    }

    try {
      const esito = await inviaRisposta(db, req.log, config, {
        thread_id: analizzato.data.thread_id,
        agent_id: analizzato.data.agent_id ?? null,
        testo: analizzato.data.testo,
      })
      // Il destinatario è un alias del relay: non lo rimandiamo indietro,
      // non serve all'interfaccia e non ha motivo di girare.
      return reply.code(200).send({
        message_id: esito.message_id,
        rfc822_id: esito.rfc822_id,
      })
    } catch (errore) {
      req.log.error(
        { thread_id: analizzato.data.thread_id, err: messaggioErrore(errore) },
        'invio della risposta fallito',
      )
      return reply.code(502).send({ errore: messaggioErrore(errore) })
    }
  })
}
