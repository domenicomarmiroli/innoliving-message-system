import type { FastifyInstance } from 'fastify'
import { z } from 'zod'

import type { Config } from '../config.js'
import type { Db } from '../db/index.js'
import { verificaAgente } from '../core/agente.js'
import { estraiTesto } from '../core/ai/estrazione.js'
import { scaricaAllegato } from '../core/storage.js'

/**
 * Caricamento di un documento nella knowledge base — riservato al ruolo
 * admin. Passa dal worker perché serve estrarre il testo dal file (PDF),
 * cosa che non ha senso far fare al browser. Solo sessione agente: non
 * ha senso un token di automazione qui, è un'azione umana da pannello.
 */

const corpo = z.object({
  storage_path: z.string().min(1),
  file_nome: z.string().min(1),
  mime: z.string().min(1),
  titolo: z.string().min(1).max(200),
  tag: z.array(z.string().min(1)).max(20).default([]),
})

export async function knowledgeRoutes(app: FastifyInstance, opts: { db: Db; config: Config }) {
  const { db, config } = opts

  const sessione_attiva = Boolean(config.SUPABASE_URL && config.SUPABASE_ANON_KEY)
  if (!sessione_attiva) {
    app.log.warn(
      'SUPABASE_URL/SUPABASE_ANON_KEY non impostate: la rotta di caricamento knowledge base resta disattivata',
    )
    return
  }

  app.post('/knowledge', async (req, reply) => {
    const headerAuth = req.headers.authorization
    const tokenSessione = headerAuth?.startsWith('Bearer ') ? headerAuth.slice(7) : null
    const agente = tokenSessione ? await verificaAgente(db, config, tokenSessione) : null
    if (!agente) return reply.code(401).send({ errore: 'non autorizzato' })
    if (agente.ruolo !== 'admin') {
      return reply.code(403).send({ errore: 'solo un admin può caricare documenti nella knowledge base' })
    }

    const analizzato = corpo.safeParse(req.body)
    if (!analizzato.success) {
      return reply.code(400).send({
        errore: 'richiesta non valida',
        dettagli: analizzato.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`),
      })
    }
    const { storage_path, file_nome, mime, titolo, tag } = analizzato.data

    try {
      const contenuto = await scaricaAllegato(config, storage_path)
      const testo = await estraiTesto(contenuto, mime, file_nome)

      const [riga] = await db<{ id: string }[]>`
        insert into knowledge (
          titolo, contenuto, fonte, file_nome, storage_path, tag, creato_da
        ) values (
          ${titolo}, ${testo}, 'documento', ${file_nome}, ${storage_path},
          ${tag}, ${agente.id}
        )
        returning id
      `

      req.log.info({ knowledge_id: riga!.id, titolo, caratteri: testo.length }, 'documento aggiunto alla knowledge base')
      return reply.code(200).send({ id: riga!.id, caratteri_estratti: testo.length })
    } catch (errore) {
      req.log.error(
        { err: errore instanceof Error ? errore.message : String(errore), file_nome },
        'caricamento documento nella knowledge base fallito',
      )
      return reply.code(502).send({
        errore: errore instanceof Error ? errore.message : String(errore),
      })
    }
  })
}
