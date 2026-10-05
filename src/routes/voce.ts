import { timingSafeEqual } from 'node:crypto'
import type { FastifyInstance, FastifyRequest } from 'fastify'
import { z } from 'zod'

import type { Config } from '../config.js'
import type { Db } from '../db/index.js'
import { registraChiamataVoce } from '../connectors/voce/registro.js'
import {
  cercaOrdiniPerRiferimento,
  creaSessione,
  marchioDaRaw,
  tentativiEsauriti,
} from '../connectors/voce/sessione.js'
import {
  confrontaCredenziali,
  etichettaCanale,
  nomeDiBattesimo,
  riduciRiferimento,
} from '../core/voce/verifica.js'

const testoFacoltativo = (max: number) =>
  z
    .string()
    .trim()
    .max(max)
    .nullable()
    .optional()
    .transform((v) => (v ? v : null))

const corpoVerifica = z.object({
  conversation_id: z.string().trim().min(1).max(200),
  numero_ordine: z.string().trim().min(1).max(100),
  email: testoFacoltativo(200),
  cap: testoFacoltativo(20),
  // Accettato ma non usato qui: ElevenLabs può mandarlo come variabile di
  // sistema. Finisce solo nel registro, mascherato.
  caller_number: z.string().max(50).nullable().optional(),
})

/**
 * Rotte per l'agente vocale (ElevenLabs Agents, "server tools").
 *
 * ElevenLabs non parla mai direttamente con Shopify o con il database:
 * chiama queste rotte, che rispondono con JSON minimi e già pronti da
 * dire al telefono. Ogni dato che l'agente comunica al cliente deve
 * venire da qui — è questo che gli impedisce di inventare.
 *
 * Due regole valgono per tutte le rotte di questo plugin, e stanno in
 * un hook proprio perché nessuna rotta futura possa dimenticarle:
 *  1. senza l'header `x-voice-secret` giusto si risponde 401, prima di
 *     leggere qualunque cosa;
 *  2. ogni richiesta, anche rifiutata, lascia una riga in `voice_log`
 *     con i dati personali oscurati.
 *
 * Senza `ELEVENLABS_TOOL_SECRET` il plugin non registra nessuna rotta:
 * un endpoint aperto che legge gli ordini dei clienti non può essere il
 * comportamento predefinito.
 */

const INTESTAZIONE_SECRET = 'x-voice-secret'

const esiti = new WeakMap<FastifyRequest, string>()

/** L'esito di dominio di una richiesta ('verificato', 'ordine_non_trovato'...), per il registro. */
export function impostaEsitoVoce(req: FastifyRequest, esito: string): void {
  esiti.set(req, esito)
}

function confrontoCostante(a: string, b: string): boolean {
  const ba = Buffer.from(a)
  const bb = Buffer.from(b)
  if (ba.length !== bb.length) return false
  return timingSafeEqual(ba, bb)
}

/** Il nome dello strumento è l'ultimo pezzo del percorso: '/voce/strumenti/stato-ordine' → 'stato-ordine'. */
export function nomeStrumento(percorso: string): string {
  const pulito = percorso.split('?')[0]!.replace(/\/+$/, '')
  return pulito.slice(pulito.lastIndexOf('/') + 1) || 'sconosciuto'
}

function conversationIdDi(req: FastifyRequest): string | null {
  const daCorpo = (req.body as { conversation_id?: unknown } | undefined)?.conversation_id
  const daQuery = (req.query as { conversation_id?: unknown } | undefined)?.conversation_id
  const daHeader = req.headers['x-conversation-id']
  const v = daCorpo ?? daQuery ?? daHeader
  return typeof v === 'string' && v.trim() ? v.trim().slice(0, 200) : null
}

export async function voceRoutes(app: FastifyInstance, opts: { db: Db; config: Config }) {
  const { db, config } = opts

  if (!config.ELEVENLABS_TOOL_SECRET) {
    app.log.warn('ELEVENLABS_TOOL_SECRET non impostato: le rotte per l\'agente vocale restano disattivate')
    return
  }
  const secret = config.ELEVENLABS_TOOL_SECRET

  app.addHook('onRequest', async (req, reply) => {
    const ricevuto = req.headers[INTESTAZIONE_SECRET]
    if (typeof ricevuto !== 'string' || !confrontoCostante(ricevuto, secret)) {
      req.log.warn(
        { motivo: ricevuto === undefined ? 'header assente' : 'secret non corrispondente' },
        'chiamata voce rifiutata',
      )
      esiti.set(req, 'non_autorizzato')
      return reply.code(401).send({ errore: 'non_autorizzato' })
    }
  })

  // Dopo la risposta, non prima: la scrittura del registro non deve
  // aggiungere latenza a una conversazione telefonica.
  app.addHook('onResponse', async (req, reply) => {
    await registraChiamataVoce(db, req.log, {
      conversation_id: conversationIdDi(req),
      tool: nomeStrumento(req.routeOptions.url ?? req.url),
      richiesta: req.body ?? null,
      response_status: reply.statusCode,
      esito: esiti.get(req) ?? null,
      latency_ms: Math.round(reply.elapsedTime),
    })
  })

  // --- Fase 2: verifica di chi chiama -------------------------------------
  // Le risposte di dominio (ordine non trovato, dati sbagliati) sono 200
  // con `verificato: false` e un motivo: l'agente le deve leggere e dire,
  // non trattarle come un guasto. Un rifiuto non restituisce MAI dati
  // dell'ordine, nemmeno il nome.
  app.post('/voce/strumenti/verifica-cliente', async (req, reply) => {
    const analizzato = corpoVerifica.safeParse(req.body)
    if (!analizzato.success) {
      impostaEsitoVoce(req, 'richiesta_non_valida')
      return reply.code(400).send({
        errore: 'richiesta_non_valida',
        dettagli: analizzato.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`),
      })
    }
    const dati = analizzato.data

    if (!dati.email && !dati.cap) {
      // Non conta come tentativo: manca una domanda, non una risposta sbagliata.
      impostaEsitoVoce(req, 'dati_mancanti')
      return reply.send({ verificato: false, motivo: 'dati_mancanti' })
    }

    try {
      if (await tentativiEsauriti(db, dati.conversation_id)) {
        impostaEsitoVoce(req, 'troppi_tentativi')
        return reply.send({ verificato: false, motivo: 'troppi_tentativi' })
      }

      const ordini = await cercaOrdiniPerRiferimento(db, riduciRiferimento(dati.numero_ordine))
      const esito = confrontaCredenziali(ordini, { email: dati.email, cap: dati.cap })
      if (!esito.ok) {
        impostaEsitoVoce(req, esito.motivo)
        return reply.send({ verificato: false, motivo: esito.motivo })
      }

      const ordine = ordini.find((o) => o.id === esito.ordine.id)!
      const token = await creaSessione(db, dati.conversation_id, ordine.id)
      impostaEsitoVoce(req, 'verificato')
      return reply.send({
        verificato: true,
        session_token: token,
        nome: nomeDiBattesimo(ordine.nome),
        brand: marchioDaRaw(ordine.raw),
        canale: etichettaCanale(ordine.channel, ordine.operator),
      })
    } catch (errore) {
      req.log.error(
        { err: errore instanceof Error ? errore.message : String(errore) },
        'verifica cliente fallita',
      )
      impostaEsitoVoce(req, 'errore')
      return reply.code(503).send({ errore: 'servizio_non_disponibile' })
    }
  })

  app.get('/voce/health', async (req, reply) => {
    try {
      await db`select 1`
      impostaEsitoVoce(req, 'ok')
      return reply.send({ ok: true })
    } catch {
      impostaEsitoVoce(req, 'database_non_raggiungibile')
      return reply.code(503).send({ ok: false, errore: 'servizio_non_disponibile' })
    }
  })
}
