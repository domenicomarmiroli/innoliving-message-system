import type { FastifyInstance } from 'fastify'

import type { Config } from '../config.js'
import type { Db } from '../db/index.js'
import { esitoRichiamata, estraiChiamata, estraiFallimento, notaChiamata, verificaFirmaElevenLabs } from '../core/voce/fine-chiamata.js'
import { registraEsito } from '../connectors/voce/richiamate.js'

/**
 * `POST /voce/webhook/fine-chiamata` — il webhook "post-call" di
 * ElevenLabs. Plugin separato da `voce.ts`: qui l'autenticazione è la
 * firma HMAC di ElevenLabs, non l'header `x-voice-secret` degli strumenti.
 *
 * Salva la trascrizione in `voice_call` e la collega al ticket della
 * telefonata: quello aperto dall'agente (chiave `conversation_id`) o, se la
 * telefonata è finita come nota in un ticket esistente, quello che ha la
 * nota con quella chiave. L'interfaccia la mostra in un popup dal ticket.
 *
 * Idempotente sul `conversation_id`: ElevenLabs può ritentare con lo
 * stesso payload. Senza `ELEVENLABS_WEBHOOK_SECRET` la rotta non esiste.
 */
export async function voceWebhookRoutes(app: FastifyInstance, opts: { db: Db; config: Config }) {
  const { db, config } = opts
  const segreto = config.ELEVENLABS_WEBHOOK_SECRET
  if (!segreto) return

  app.addContentTypeParser('application/json', { parseAs: 'buffer' }, (req, body, done) => {
    ;(req as { rawBody?: Buffer }).rawBody = body as Buffer
    try {
      done(null, JSON.parse((body as Buffer).toString('utf8')))
    } catch (err) {
      done(err as Error, undefined)
    }
  })

  app.post('/voce/webhook/fine-chiamata', async (req, reply) => {
    const grezzo = (req as { rawBody?: Buffer }).rawBody
    const firma = req.headers['elevenlabs-signature']
    if (!grezzo || !verificaFirmaElevenLabs(typeof firma === 'string' ? firma : undefined, grezzo, segreto)) {
      req.log.warn('webhook di fine chiamata con firma non valida')
      return reply.code(401).send({ errore: 'firma non valida' })
    }

    // Audio e chiamate non riuscite arrivano allo stesso indirizzo: per
    // ora servono solo le trascrizioni. 200, altrimenti ElevenLabs conta
    // un fallimento e dopo dieci disattiva il webhook.
    // Richiamata che non ha nemmeno squillato fino in fondo (nessuna
    // risposta, occupato): si pianifica il tentativo successivo.
    const fallita = estraiFallimento(req.body)
    if (fallita) {
      try {
        await registraEsito(db, req.log, fallita.conversation_id, fallita.motivo, null)
        return reply.code(200).send({ ok: true })
      } catch (errore) {
        req.log.error({ err: errore instanceof Error ? errore.message : String(errore) }, 'esito della richiamata non registrato')
        return reply.code(500).send({ errore: 'salvataggio non riuscito' })
      }
    }

    const chiamata = estraiChiamata(req.body)
    if (!chiamata) return reply.code(200).send({ ok: true, ignorato: true })

    try {
      // Una richiamata (chiamata in uscita): esito e nota li scrive
      // registraEsito; qui resta solo il salvataggio della trascrizione.
      const threadRichiamata = await registraEsito(db, req.log, chiamata.conversation_id, esitoRichiamata(chiamata), chiamata.riassunto)
      const [threadInArrivo] = threadRichiamata ? [] : await db<{ id: string }[]>`
        select t.id from thread t
        join channel_account ca on ca.id = t.account_id
        where ca.kind = 'telefono' and t.external_thread_id = ${chiamata.conversation_id}
        union all
        select m.thread_id from message m
        where m.interno and m.external_id like ${`${chiamata.conversation_id}:%`}
        union all
        -- Nessun ticket toccato dalla chiamata (caso reale 06/10: l'agente
        -- ha solo riferito la pratica già aperta): il ticket dell'ordine
        -- verificato in quella conversazione.
        select x.id from (
          select t.id from voice_session vs
          join thread t on t.order_id = vs.order_id and t.linked_thread_id is null
          where vs.conversation_id = ${chiamata.conversation_id}
          order by (t.state <> 'closed') desc, t.last_inbound_at desc nulls last
          limit 1
        ) x
        limit 1
      `
      const thread = threadRichiamata ? { id: threadRichiamata } : threadInArrivo
      await db`
        insert into voice_call (
          conversation_id, agent_ref, summary, outcome, durata_secondi, iniziata_at,
          trascrizione, thread_id, raw,
          costo_crediti, crediti_voce, crediti_llm, costo_usd, chiamata_test,
          verificato, ticket_aperto
        ) values (
          ${chiamata.conversation_id}, ${chiamata.agent_ref}, ${chiamata.riassunto}, ${chiamata.esito},
          ${chiamata.durata_secondi}, ${chiamata.iniziata_at},
          ${db.json(chiamata.trascrizione as unknown as Parameters<typeof db.json>[0])},
          ${thread?.id ?? null}, ${db.json(req.body as Parameters<typeof db.json>[0])},
          ${chiamata.costo_crediti}, ${chiamata.crediti_voce}, ${chiamata.crediti_llm},
          ${chiamata.costo_usd}, ${chiamata.chiamata_test},
          exists (select 1 from voice_session where conversation_id = ${chiamata.conversation_id}),
          exists (
            select 1 from thread t join channel_account ca on ca.id = t.account_id
            where ca.kind = 'telefono' and t.external_thread_id = ${chiamata.conversation_id}
          )
        )
        on conflict (conversation_id) do update set
          agent_ref      = excluded.agent_ref,
          summary        = excluded.summary,
          outcome        = excluded.outcome,
          durata_secondi = excluded.durata_secondi,
          iniziata_at    = excluded.iniziata_at,
          trascrizione   = excluded.trascrizione,
          thread_id      = coalesce(excluded.thread_id, voice_call.thread_id),
          raw            = excluded.raw,
          costo_crediti  = excluded.costo_crediti,
          crediti_voce   = excluded.crediti_voce,
          crediti_llm    = excluded.crediti_llm,
          costo_usd      = excluded.costo_usd,
          chiamata_test  = excluded.chiamata_test,
          verificato     = excluded.verificato,
          ticket_aperto  = excluded.ticket_aperto,
          updated_at     = now()
      `
      // Se nella chiamata l'agente non ha scritto niente nel ticket (ha solo
      // riferito la pratica), una nota breve la rende visibile scorrendo la
      // conversazione. Stesso prefisso delle note dell'agente: l'interfaccia
      // ci mette accanto "Vedi trascrizione". Idempotente sulla chiave.
      if (thread && !threadRichiamata) {
        await db`
          insert into message (thread_id, direction, author_kind, external_id, body_text, interno, sent_at)
          select ${thread.id}, 'out', 'agent', ${`${chiamata.conversation_id}:chiamata`},
                 ${notaChiamata(chiamata.durata_secondi)}, true, coalesce(${chiamata.iniziata_at}, now())
          where not exists (
            select 1 from message
            where thread_id = ${thread.id} and external_id like ${`${chiamata.conversation_id}:%`}
          )
          on conflict (thread_id, external_id) do nothing
        `
      }
      req.log.info(
        { conversation_id: chiamata.conversation_id, thread_id: thread?.id ?? null, battute: chiamata.trascrizione.length },
        'trascrizione della telefonata salvata',
      )
      return reply.code(200).send({ ok: true })
    } catch (errore) {
      req.log.error(
        { err: errore instanceof Error ? errore.message : String(errore) },
        'salvataggio della trascrizione fallito',
      )
      // 500: con i ritentativi attivi ElevenLabs riprova.
      return reply.code(500).send({ errore: 'salvataggio non riuscito' })
    }
  })
}
