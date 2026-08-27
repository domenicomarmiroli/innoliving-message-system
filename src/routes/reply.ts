import { timingSafeEqual } from 'node:crypto'
import type { FastifyInstance } from 'fastify'
import { z } from 'zod'

import type { Config } from '../config.js'
import type { Db } from '../db/index.js'
import { verificaAgente } from '../core/agente.js'
import { calcolaEsito } from '../core/ai/esito.js'
import { check as verificaPolicy } from '../core/policy.js'
import { prepare, type FilePronto } from '../core/attachments/normalize.js'
import { scaricaAllegato } from '../core/storage.js'
import { inviaRisposta } from '../connectors/mail/invia.js'
import { inviaMessaggioMirakl } from '../connectors/mirakl/invia.js'
import { messaggioErrore } from '../connectors/mail/imap.js'

/**
 * Invio di una risposta, chiamato dall'interfaccia.
 *
 * Due modi di autenticarsi, per due chiamanti diversi:
 *  - X-Worker-Token: WORKER_API_TOKEN — per automazioni da server a
 *    server, dove non c'è un agente loggato dietro la chiamata;
 *  - Authorization: Bearer <token di sessione Supabase> — per l'agente
 *    che scrive dall'interfaccia. Il worker chiede a Supabase Auth di
 *    chi è quel token invece di tenere un segreto condiviso col browser:
 *    un token statico lì dentro sarebbe estraibile dagli strumenti
 *    sviluppatore e userebbe a chiunque per spedire dall'identità
 *    venditore, bypassando anche le policy RLS di Lovable.
 * Senza ALMENO UNO dei due meccanismi configurato, la rotta non viene
 * registrata affatto: un endpoint aperto che spedisce dall'identità
 * venditore è troppo pericoloso per essere il comportamento predefinito.
 */

const corpo = z.object({
  thread_id: z.string().uuid(),
  testo: z.string().min(1).max(20_000),
  agent_id: z.string().uuid().nullable().optional(),
  // Se il testo parte da una bozza AI generata da POST /threads/draft,
  // l'interfaccia passa l'id: serve a chiudere il cerchio in ai_draft
  // (outcome/final_text) per confrontare la proposta con cosa è stato
  // davvero spedito. Facoltativo: un testo scritto da zero non ce l'ha.
  draft_id: z.string().uuid().nullable().optional(),
  // Solo per i thread Mirakl: a chi va la risposta. Un thread può avere
  // due controparti (il cliente e l'operatore del marketplace stesso),
  // e l'agente sceglie come sul portale Mirakl. Vuoto/assente ⇒ cliente.
  mirakl_destinatari: z.array(z.enum(['CUSTOMER', 'OPERATOR'])).max(2).optional(),
  // Riferimenti a file già caricati dall'interfaccia direttamente su
  // Supabase Storage (stesso bucket 'allegati', percorso a sua scelta):
  // il worker li scarica, li normalizza per canale e solo allora li spedisce.
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

export async function replyRoutes(
  app: FastifyInstance,
  opts: { db: Db; config: Config },
) {
  const { db, config } = opts

  const worker_token_attivo = Boolean(config.WORKER_API_TOKEN)
  const sessione_attiva = Boolean(config.SUPABASE_URL && config.SUPABASE_ANON_KEY)

  if (!worker_token_attivo && !sessione_attiva) {
    app.log.warn(
      'nessuna autenticazione configurata (WORKER_API_TOKEN o SUPABASE_URL/SUPABASE_ANON_KEY): ' +
        'la rotta di invio risposta resta disattivata',
    )
    return
  }

  app.post('/threads/reply', async (req, reply) => {
    // --- Autenticazione: token di servizio, poi sessione agente ---------
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
    // Con una sessione agente, chi ha inviato è l'agente autenticato, non
    // un agent_id qualunque nel corpo: altrimenti chiunque potrebbe
    // firmare l'invio col nome di un collega.
    if (agente_id) analizzato.data.agent_id = agente_id

    try {
      // Da quale canale si risponde lo decide la conversazione, non chi
      // chiama: l'interfaccia non deve sapere che Mirakl ha una API e
      // Amazon no. Mandare per SMTP una risposta Mirakl la farebbe
      // sparire senza errore.
      const [canale] = await db<{ kind: string }[]>`
        select ca.kind
        from thread t join channel_account ca on ca.id = t.account_id
        where t.id = ${analizzato.data.thread_id}
      `
      if (!canale) return reply.code(404).send({ errore: 'conversazione inesistente' })

      // Le regole di contenuto valgono qui, prima di chiamare qualunque
      // adapter: né l'interfaccia né una bozza AI possono aggirarle.
      const policy = verificaPolicy(canale.kind, analizzato.data.testo)
      if (!policy.ok) {
        return reply.code(422).send({
          errore: 'contenuto non ammesso su questo canale',
          violazioni: policy.violazioni,
        })
      }

      const richiestaAllegati = analizzato.data.allegati ?? []

      // Ogni allegato passa dalla normalizzazione per canale — su Amazon
      // converte JPG/HEIC e ricomprime, non solo valida — PRIMA di essere
      // spedito. Un allegato rifiutato blocca l'intero invio: l'agente
      // deve saperlo prima che il testo parta senza la foto che serviva.
      const allegatiPronti: FilePronto[] = []
      for (const rif of richiestaAllegati) {
        const contenuto = await scaricaAllegato(config, rif.storage_path)
        const esito = await prepare(canale.kind, {
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

      const esito =
        canale.kind === 'mirakl'
          ? await inviaMessaggioMirakl(db, req.log, config, {
              thread_id: analizzato.data.thread_id,
              agent_id: analizzato.data.agent_id ?? null,
              draft_id: analizzato.data.draft_id ?? null,
              testo: analizzato.data.testo,
              allegati: allegatiPronti,
              destinatari: analizzato.data.mirakl_destinatari,
            }).then((e) => ({ message_id: e.message_id, rfc822_id: null }))
          : await inviaRisposta(db, req.log, config, {
              thread_id: analizzato.data.thread_id,
              agent_id: analizzato.data.agent_id ?? null,
              draft_id: analizzato.data.draft_id ?? null,
              testo: analizzato.data.testo,
              allegati: allegatiPronti,
            })
      // Chiude il cerchio con la bozza AI, se questo invio ne veniva una:
      // non deve mai far fallire l'invio già avvenuto, quindi solo un log
      // se qualcosa non torna (bozza di un altro thread, già cancellata).
      if (analizzato.data.draft_id) {
        try {
          const [bozza] = await db<{ draft_text: string | null }[]>`
            select draft_text from ai_draft
            where id = ${analizzato.data.draft_id} and thread_id = ${analizzato.data.thread_id}
          `
          if (bozza) {
            const esitoBozza = calcolaEsito(bozza.draft_text ?? '', analizzato.data.testo)
            await db`
              update ai_draft
              set outcome = ${esitoBozza}, final_text = ${analizzato.data.testo}, updated_at = now()
              where id = ${analizzato.data.draft_id}
            `
          } else {
            req.log.warn(
              { draft_id: analizzato.data.draft_id, thread_id: analizzato.data.thread_id },
              'draft_id passato a /threads/reply non trovato per questo thread',
            )
          }
        } catch (erroreEsito) {
          req.log.warn(
            { draft_id: analizzato.data.draft_id, err: messaggioErrore(erroreEsito) },
            'aggiornamento esito bozza AI fallito, invio già andato a buon fine',
          )
        }
      }

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
