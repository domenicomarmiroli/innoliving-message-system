import { timingSafeEqual } from 'node:crypto'
import type { FastifyInstance } from 'fastify'
import { z } from 'zod'

import type { Config } from '../config.js'
import type { Db } from '../db/index.js'
import { verificaAgente } from '../core/agente.js'
import { check as verificaPolicy } from '../core/policy.js'
import { creaProvider } from '../core/ai/provider.js'
import { linguaClienteDelThread, nomeLingua, traduciPerCliente } from '../core/ai/traduzione.js'

/**
 * Anteprima della traduzione di una risposta, prima dell'invio.
 *
 * L'operatore scrive in italiano; questa rotta restituisce la versione
 * nella lingua del cliente **senza spedire niente**. L'invio vero resta
 * `/threads/reply`, con il testo tradotto che l'operatore ha visto: si
 * spedisce l'anteprima, non una seconda traduzione fatta al momento — due
 * chiamate al modello non danno mai lo stesso testo, e partirebbe
 * qualcosa che nessuno ha guardato.
 *
 * La policy del canale si controlla **sul testo tradotto**, perché è
 * quello che il marketplace riceve: un link o un invito a contattarci
 * fuori piattaforma si vede qui, in anteprima, non al momento di inviare.
 *
 * Stessa autenticazione di /threads/draft e /threads/reply.
 */

const corpo = z.object({
  thread_id: z.string().uuid(),
  testo: z.string().min(1).max(20_000),
  /**
   * Facoltativa: la lingua scelta a mano dall'operatore. Senza, si usa
   * quella dell'ultimo messaggio del cliente già esaminato.
   */
  lingua: z
    .string()
    .regex(/^[a-z]{2}$/, 'codice ISO 639-1 di due lettere minuscole')
    .optional(),
})

function confrontoCostante(a: string, b: string): boolean {
  const ba = Buffer.from(a)
  const bb = Buffer.from(b)
  if (ba.length !== bb.length) return false
  return timingSafeEqual(ba, bb)
}

export async function traduzioneRoutes(app: FastifyInstance, opts: { db: Db; config: Config }) {
  const { db, config } = opts

  const worker_token_attivo = Boolean(config.WORKER_API_TOKEN)
  const sessione_attiva = Boolean(config.SUPABASE_URL && config.SUPABASE_ANON_KEY)
  if (!worker_token_attivo && !sessione_attiva) return
  if (!config.ANTHROPIC_API_KEY) {
    app.log.warn('ANTHROPIC_API_KEY non impostata: la rotta di traduzione resta disattivata')
    return
  }

  app.post('/threads/traduci', async (req, reply) => {
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
    const { thread_id, testo } = analizzato.data

    const [canale] = await db<{ kind: string }[]>`
      select ca.kind from thread t join channel_account ca on ca.id = t.account_id
      where t.id = ${thread_id}
    `
    if (!canale) return reply.code(404).send({ errore: 'conversazione inesistente' })

    const lingua = analizzato.data.lingua ?? (await linguaClienteDelThread(db, thread_id))

    // Cliente italiano, o lingua non ancora nota: niente da tradurre. Lo
    // si dice esplicitamente invece di restituire un errore, così
    // l'interfaccia mostra "nessuna traduzione necessaria" e basta.
    if (!lingua || lingua === 'it') {
      return reply.code(200).send({
        tradotto: false,
        lingua,
        nome_lingua: lingua ? nomeLingua(lingua) : null,
        testo,
        policy: verificaPolicy(canale.kind, testo),
      })
    }

    try {
      // Modello economico anche in uscita, su richiesta di Domenico (06/10).
      const provider = await creaProvider(config, config.ANTHROPIC_MODEL_CLASSIFICAZIONE, { funzione: 'traduzione_uscita', sfondo: false })
      const tradotto = await traduciPerCliente(provider, testo, lingua)
      return reply.code(200).send({
        tradotto: true,
        lingua,
        nome_lingua: nomeLingua(lingua),
        testo: tradotto,
        policy: verificaPolicy(canale.kind, tradotto),
      })
    } catch (errore) {
      const messaggio = errore instanceof Error ? errore.message : String(errore)
      req.log.error({ thread_id, lingua, err: messaggio }, 'traduzione della risposta non riuscita')
      return reply.code(502).send({ errore: messaggio })
    }
  })
}
