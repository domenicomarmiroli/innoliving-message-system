import { timingSafeEqual } from 'node:crypto'
import type { FastifyInstance } from 'fastify'
import { z } from 'zod'

import type { Config } from '../config.js'
import type { Db } from '../db/index.js'

/**
 * Apertura ticket dai siti esterni — passo successivo al Contattaci con
 * agente AI: quando il cliente vuole davvero parlare con qualcuno,
 * l'agente del sito chiama questo endpoint invece di mandare un'email
 * formattata a mano, che avrebbe costretto `ripulisci.ts`/`riconosci.ts`
 * (pensati per email umane inoltrate da un marketplace) a interpretare
 * un caso che non è il loro.
 *
 * Un `channel_account` per sito/brand, kind = 'contatto' (migrazione
 * 0016) — il codice non sa quanti siti ci sono né come si chiamano, il
 * brand di un ticket è sempre quello nell'URL.
 *
 * **Un solo token per tutti i brand** (`CONTATTO_TOKEN`), non uno per
 * riga come per gli operatori Mirakl: qui non c'è un vero bisogno di
 * isolamento — stesso sito, stessa infrastruttura, gestiti dalla stessa
 * persona — e un token per brand sarebbe stata solo un'occasione in più
 * di sbagliare la configurazione. Il token autentica il chiamante, il
 * `:codice` nell'URL sceglie il brand: sono due cose distinte anche se
 * oggi il secondo controllo (`CONTATTO_TOKEN` impostato) è unico.
 *
 * **Deve girare lato server**, non dal browser del sito: il token è un
 * segreto condiviso, e mai un segreto finisce nel bundle di un sito
 * pubblico. Per questo qui non c'è CORS: non è pensato per essere
 * chiamato da JavaScript in una pagina.
 *
 * Nessuna sessione agente qui: chi chiama non è un operatore che scrive
 * dall'interfaccia, è un sistema esterno che segnala un cliente nuovo.
 */

const corpo = z.object({
  email: z.string().email(),
  nome: z.string().trim().min(1).max(200).nullable().optional(),
  numero_ordine: z.string().trim().min(1).max(100).nullable().optional(),
  testo: z.string().min(1).max(10_000),
  // Facoltativo: se il chiamante lo manda, un retry con lo stesso valore
  // non apre un secondo ticket. Se manca, il rischio di duplicato in un
  // retry di rete resta a carico del chiamante.
  richiesta_id: z.string().trim().min(1).max(200).optional(),
})

function confrontoCostante(a: string, b: string): boolean {
  const ba = Buffer.from(a)
  const bb = Buffer.from(b)
  if (ba.length !== bb.length) return false
  return timingSafeEqual(ba, bb)
}

/** Il numero d'ordine si confronta esatto, o senza un eventuale '#' iniziale. */
export function normalizzaNumeroOrdine(v: string): string {
  return v.trim().replace(/^#/, '')
}

export async function contattiRoutes(app: FastifyInstance, opts: { db: Db; config: Config }) {
  const { db, config } = opts

  if (!config.CONTATTO_TOKEN) {
    app.log.warn(
      'CONTATTO_TOKEN non impostato: la rotta di apertura ticket dai siti esterni resta disattivata',
    )
    return
  }
  const chiave = config.CONTATTO_TOKEN

  app.post('/contatti/:codice/ticket', async (req, reply) => {
    const { codice } = req.params as { codice: string }

    const headerAuth = req.headers.authorization
    const token = headerAuth?.startsWith('Bearer ') ? headerAuth.slice(7) : null
    if (!token || !confrontoCostante(token, chiave)) {
      // Mai il valore del token nei log — solo la forma, per capire senza
      // maneggiare il segreto: header assente, senza 'Bearer ', o presente
      // ma diverso da quello configurato per questo sito.
      req.log.warn(
        {
          codice,
          motivo: !headerAuth
            ? 'header Authorization assente'
            : !headerAuth.startsWith('Bearer ')
              ? "header presente ma senza prefisso 'Bearer '"
              : 'token presente ma non corrisponde a quello configurato',
        },
        'apertura ticket rifiutata: token non valido',
      )
      return reply.code(401).send({ errore: 'non autorizzato' })
    }

    const [account] = await db<{ id: string; sla_minutes: number; active: boolean }[]>`
      select id, sla_minutes, active
      from channel_account
      where code = ${codice} and kind = 'contatto'
    `
    if (!account || !account.active) {
      return reply.code(404).send({ errore: 'sito non configurato' })
    }

    const analizzato = corpo.safeParse(req.body)
    if (!analizzato.success) {
      return reply.code(400).send({
        errore: 'richiesta non valida',
        dettagli: analizzato.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`),
      })
    }
    const dati = analizzato.data

    try {
      const [ordine] = dati.numero_ordine
        ? await db<{ id: string }[]>`
            select id from "order"
            where external_order_id = ${dati.numero_ordine}
               or shopify_name = ${normalizzaNumeroOrdine(dati.numero_ordine)}
               or shopify_name = ${'#' + normalizzaNumeroOrdine(dati.numero_ordine)}
            limit 1
          `
        : []
      const orderId = ordine?.id ?? null

      const ora = new Date()
      const scadenza = new Date(ora.getTime() + account.sla_minutes * 60_000)
      const oggetto = dati.numero_ordine
        ? `Contatto dal sito — ordine ${dati.numero_ordine}`
        : 'Contatto dal sito'

      const risultato = await db.begin(async (tx) => {
        let threadId: string
        if (dati.richiesta_id) {
          const [riga] = await tx<{ id: string; created: boolean }[]>`
            insert into thread (
              account_id, external_thread_id, order_id, subject, state,
              first_inbound_at, last_inbound_at, due_at
            ) values (
              ${account.id}, ${dati.richiesta_id}, ${orderId}, ${oggetto},
              ${orderId ? 'new' : 'unmatched'}, ${ora}, ${ora}, ${scadenza}
            )
            on conflict (account_id, external_thread_id)
              where external_thread_id is not null
            do update set updated_at = now()
            returning id, (xmax = 0) as created
          `
          threadId = riga!.id
        } else {
          const [riga] = await tx<{ id: string }[]>`
            insert into thread (
              account_id, order_id, subject, state,
              first_inbound_at, last_inbound_at, due_at
            ) values (
              ${account.id}, ${orderId}, ${oggetto},
              ${orderId ? 'new' : 'unmatched'}, ${ora}, ${ora}, ${scadenza}
            )
            returning id
          `
          threadId = riga!.id
        }

        const [messaggio] = await tx<{ id: string }[]>`
          insert into message (
            thread_id, direction, author_kind, external_id, body_text, sent_at, raw
          ) values (
            ${threadId}, 'in', 'customer',
            ${dati.richiesta_id ?? null}, ${dati.testo}, ${ora},
            ${tx.json({
              from: dati.email,
              nome: dati.nome ?? null,
              numero_ordine_dichiarato: dati.numero_ordine ?? null,
              subject: oggetto,
            } as never)}
          )
          on conflict (thread_id, external_id) do nothing
          returning id
        `

        return { thread_id: threadId, message_id: messaggio?.id ?? null }
      })

      req.log.info(
        { codice, thread_id: risultato.thread_id, agganciato: orderId !== null },
        'ticket aperto da contatto sito',
      )
      return reply.code(200).send(risultato)
    } catch (errore) {
      req.log.error(
        { codice, err: errore instanceof Error ? errore.message : String(errore) },
        'apertura ticket da contatto sito fallita',
      )
      return reply.code(502).send({
        errore: errore instanceof Error ? errore.message : String(errore),
      })
    }
  })
}
