import { timingSafeEqual } from 'node:crypto'
import type { FastifyInstance, FastifyRequest } from 'fastify'
import { z } from 'zod'

import type { Config } from '../config.js'
import type { Db } from '../db/index.js'
import { verificaAgente } from '../core/agente.js'
import { TIPI_RESO } from '../core/reso/foglio.js'
import { urlFirmato } from '../core/storage.js'
import { testoReso } from '../connectors/reso/testo.js'
import { ErroreEtichetta, generaEtichettaReso, generaEtichettaResoOrdine } from '../connectors/reso/etichetta.js'

/**
 * POST /threads/etichetta-reso   { thread_id, tipo: recesso | danneggiato | verificare }
 *
 * Restituisce il foglio di reso già su Storage, nella stessa forma degli
 * allegati di /threads/reply ({ storage_path, nome_file, mime }): l'editor
 * lo aggiunge al messaggio e l'operatore lo spedisce con la risposta.
 * Ripetere la richiesta per lo stesso ticket e tipo restituisce la stessa
 * etichetta, mai una seconda spedizione BRT.
 */

function confrontoCostante(a: string, b: string): boolean {
  const ba = Buffer.from(a)
  const bb = Buffer.from(b)
  return ba.length === bb.length && timingSafeEqual(ba, bb)
}

const corpo = z.object({
  thread_id: z.string().uuid(),
  tipo: z.enum(TIPI_RESO),
})

export async function etichettaResoRoutes(app: FastifyInstance, opts: { db: Db; config: Config }) {
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

  /**
   * POST /threads/etichetta-reso-ordine
   *   { numero_ordine, tipo, canale?, nome_cliente? }
   *
   * Etichetta di reso senza ticket, da numero d'ordine: l'operatore scarica
   * il foglio dal link e lo manda al cliente a mano (canali non integrati
   * come BricoBravo). Se l'ordine non è nell'Hub servono canale e nome del
   * cliente. Ripetere la richiesta restituisce la stessa etichetta, con un
   * nuovo link di download (valido un'ora).
   */
  const corpoOrdine = z.object({
    numero_ordine: z.string().trim().min(1).max(100),
    tipo: z.enum(TIPI_RESO),
    canale: z.string().trim().min(1).max(40).nullable().optional(),
    nome_cliente: z.string().trim().min(1).max(120).nullable().optional(),
  })

  app.post('/threads/etichetta-reso-ordine', async (req, reply) => {
    const agente = await chiChiama(req)
    if (agente === undefined) return reply.code(401).send({ errore: 'non autorizzato' })
    const c = corpoOrdine.safeParse(req.body)
    if (!c.success) return reply.code(400).send({ errore: c.error.issues.map((i) => i.message).join('; ') })
    try {
      const etichetta = await generaEtichettaResoOrdine(db, config, req.log, { ...c.data, agent_id: agente })
      const url_download = await urlFirmato(config, etichetta.storage_path, 3600)
      // Il testo da incollare nella mail: dal modello della tipologia, già compilato.
      const messaggio = await testoReso(db, etichetta.tipo, etichetta)
      return reply.send({ ...etichetta, url_download, messaggio })
    } catch (e) {
      if (e instanceof ErroreEtichetta) return reply.code(e.status).send({ errore: e.message })
      req.log.error({ err: e }, 'etichetta di reso da ordine non generata')
      return reply.code(500).send({ errore: "errore interno durante la generazione dell'etichetta" })
    }
  })

  app.post('/threads/etichetta-reso', async (req, reply) => {
    const agente = await chiChiama(req)
    if (agente === undefined) return reply.code(401).send({ errore: 'non autorizzato' })
    const c = corpo.safeParse(req.body)
    if (!c.success) return reply.code(400).send({ errore: c.error.issues.map((i) => i.message).join('; ') })
    try {
      const etichetta = await generaEtichettaReso(db, config, req.log, { ...c.data, agent_id: agente })
      return reply.send(etichetta)
    } catch (e) {
      if (e instanceof ErroreEtichetta) return reply.code(e.status).send({ errore: e.message })
      req.log.error({ err: e }, 'etichetta di reso non generata')
      return reply.code(500).send({ errore: "errore interno durante la generazione dell'etichetta" })
    }
  })
}
