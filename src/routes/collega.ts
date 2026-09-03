import { timingSafeEqual } from 'node:crypto'
import type { FastifyInstance } from 'fastify'
import { z } from 'zod'

import type { Config } from '../config.js'
import type { Db } from '../db/index.js'
import { verificaAgente } from '../core/agente.js'
import { check as verificaPolicy } from '../core/policy.js'
import { prepare, type FilePronto } from '../core/attachments/normalize.js'
import { scaricaAllegato } from '../core/storage.js'
import { apriTicketCollegato } from '../connectors/mail/collega.js'
import { messaggioErrore } from '../connectors/mail/imap.js'

/**
 * Apertura di un ticket collegato ("linked ticket" stile Zendesk),
 * chiamato dall'interfaccia quando l'agente vuole scrivere a un
 * corriere o all'assistenza esterna per lo stesso argomento di un
 * ticket cliente. Vedi migrazione 0026 e `connectors/mail/collega.ts`.
 *
 * Stessa doppia autenticazione di `/threads/reply` (WORKER_API_TOKEN o
 * sessione Supabase): duplicata qui invece che estratta in un helper
 * condiviso, coerente con lo stesso blocco già ripetuto in
 * `reply.ts`/`draft.ts`/`knowledge.ts`.
 */

const corpo = z.object({
  thread_id: z.string().uuid(),
  destinatario: z.string().email(),
  testo: z.string().min(1).max(20_000),
  oggetto: z.string().trim().min(1).max(300).nullable().optional(),
  tipo: z.enum(['corriere', 'assistenza', 'altro']).optional(),
  agent_id: z.string().uuid().nullable().optional(),
  allegati: z
    .array(
      z.object({
        storage_path: z.string().min(1),
        nome_file: z.string().min(1),
        mime: z.string().min(1),
      }),
    )
    .max(10)
    .optional(),
})

function confrontoCostante(a: string, b: string): boolean {
  const ba = Buffer.from(a)
  const bb = Buffer.from(b)
  if (ba.length !== bb.length) return false
  return timingSafeEqual(ba, bb)
}

export async function collegaRoutes(
  app: FastifyInstance,
  opts: { db: Db; config: Config },
) {
  const { db, config } = opts

  const worker_token_attivo = Boolean(config.WORKER_API_TOKEN)
  const sessione_attiva = Boolean(config.SUPABASE_URL && config.SUPABASE_ANON_KEY)

  if (!worker_token_attivo && !sessione_attiva) {
    app.log.warn(
      'nessuna autenticazione configurata (WORKER_API_TOKEN o SUPABASE_URL/SUPABASE_ANON_KEY): ' +
        'la rotta di apertura ticket collegati resta disattivata',
    )
    return
  }

  app.post('/threads/collega', async (req, reply) => {
    let agente_id: string | null = null

    const headerWorker = req.headers['x-worker-token']
    const tokenWorker = Array.isArray(headerWorker) ? headerWorker[0] : headerWorker
    const worker_ok =
      worker_token_attivo && !!tokenWorker && confrontoCostante(tokenWorker, config.WORKER_API_TOKEN!)

    if (!worker_ok) {
      const headerAuth = req.headers.authorization
      const tokenSessione = headerAuth?.startsWith('Bearer ') ? headerAuth.slice(7) : null
      const agente = tokenSessione && sessione_attiva
        ? await verificaAgente(db, config, tokenSessione)
        : null
      if (!agente) {
        return reply.code(401).send({ errore: 'non autorizzato' })
      }
      agente_id = agente.id
    }

    const analizzato = corpo.safeParse(req.body)
    if (!analizzato.success) {
      return reply.code(400).send({
        errore: 'richiesta non valida',
        dettagli: analizzato.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`),
      })
    }
    // Con una sessione agente, chi apre il ticket è l'agente autenticato,
    // non un agent_id qualunque nel corpo (stesso motivo di reply.ts).
    if (agente_id) analizzato.data.agent_id = agente_id

    try {
      const [padre] = await db<{ id: string }[]>`
        select id from thread where id = ${analizzato.data.thread_id}
      `
      if (!padre) return reply.code(404).send({ errore: 'ticket di partenza inesistente' })

      // Il canale del nuovo ticket è sempre 'email' (la casella): le
      // regole di contenuto valgono comunque, per coerenza con
      // /threads/reply, anche se oggi email non ne ha nessuna.
      const policy = verificaPolicy('email', analizzato.data.testo)
      if (!policy.ok) {
        return reply.code(422).send({
          errore: 'contenuto non ammesso',
          violazioni: policy.violazioni,
        })
      }

      const richiestaAllegati = analizzato.data.allegati ?? []
      const allegatiPronti: FilePronto[] = []
      for (const rif of richiestaAllegati) {
        const contenuto = await scaricaAllegato(config, rif.storage_path)
        const esito = await prepare('email', {
          nome_file: rif.nome_file,
          mime: rif.mime,
          contenuto,
        })
        if (!esito.ok) {
          return reply.code(422).send({
            errore: `allegato "${rif.nome_file}" non ammesso: ${esito.motivo}`,
          })
        }
        allegatiPronti.push(esito)
      }

      const esito = await apriTicketCollegato(db, req.log, config, {
        thread_id: analizzato.data.thread_id,
        agent_id: analizzato.data.agent_id ?? null,
        destinatario: analizzato.data.destinatario,
        testo: analizzato.data.testo,
        oggetto: analizzato.data.oggetto ?? null,
        tipo: analizzato.data.tipo,
        allegati: allegatiPronti,
      })

      return reply.code(200).send({
        thread_id: esito.thread_id,
        message_id: esito.message_id,
        rfc822_id: esito.rfc822_id,
        avvisi: policy.violazioni.filter((v) => !v.bloccante),
      })
    } catch (errore) {
      req.log.error(
        { thread_id: analizzato.data.thread_id, err: messaggioErrore(errore) },
        'apertura ticket collegato fallita',
      )
      return reply.code(502).send({ errore: messaggioErrore(errore) })
    }
  })
}
