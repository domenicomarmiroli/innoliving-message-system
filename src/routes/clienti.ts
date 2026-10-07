import { timingSafeEqual } from 'node:crypto'
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import { z } from 'zod'

import type { Config } from '../config.js'
import type { Db } from '../db/index.js'
import { ETICHETTA_STATO, normalizzaEmail, statoPerCliente, testoPerCliente } from '../core/clienti/area.js'

/**
 * I ticket di un cliente, per l'area cliente dei siti.
 *
 * `GET /clienti/ticket?email=…` (elenco) e `GET /clienti/ticket/:id?email=…`
 * (conversazione). Chiamate SERVER-TO-SERVER dal sito, con lo stesso
 * `CONTATTO_TOKEN` dell'apertura ticket: l'email non la sceglie il browser,
 * il sito la prende dal profilo Shopify del cliente loggato. Per questo il
 * token non deve mai finire nel bundle servito al browser, e qui non c'è CORS.
 *
 * Quali ticket sono suoi: quelli in cui ha scritto da quell'indirizzo
 * (email, form del sito, telefono con email lasciata) o legati a un suo
 * ordine (`order.email`). Solo canali in cui il cliente parla con noi
 * direttamente: per Amazon e Mirakl la conversazione vive sul marketplace,
 * e gli indirizzi sono alias. Mai i ticket collegati verso corriere e
 * assistenza.
 */

const CANALI_CLIENTE = ['contatto', 'email', 'telefono', 'shopify']
const MASSIMO_TICKET = 50
const MASSIMO_MESSAGGI = 200

const query = z.object({ email: z.string().email() })

function confrontoCostante(a: string, b: string): boolean {
  const ba = Buffer.from(a)
  const bb = Buffer.from(b)
  return ba.length === bb.length && timingSafeEqual(ba, bb)
}

export async function clientiRoutes(app: FastifyInstance, opts: { db: Db; config: Config }) {
  const { db, config } = opts
  const chiave = config.CONTATTO_TOKEN
  if (!chiave) return

  function autorizzato(req: FastifyRequest, reply: FastifyReply): boolean {
    const h = req.headers.authorization
    const token = h?.startsWith('Bearer ') ? h.slice(7) : null
    if (!token || !confrontoCostante(token, chiave!)) {
      void reply.code(401).send({ errore: 'non autorizzato' })
      return false
    }
    return true
  }

  // Lo stesso predicato in elenco e dettaglio: un ticket che non compare
  // nell'elenco non si apre nemmeno conoscendone l'id.
  const delCliente = (email: string) => db`
    t.linked_thread_id is null
    and ca.kind = any(${CANALI_CLIENTE})
    and (
      lower(o.email) = ${email}
      or exists (
        select 1 from message m
        where m.thread_id = t.id and m.author_kind = 'customer'
          and (lower(m.raw->>'from') = ${email} or lower(m.raw->>'reply_to') = ${email})
      )
    )
  `

  app.get('/clienti/ticket', async (req, reply) => {
    if (!autorizzato(req, reply)) return
    const q = query.safeParse(req.query)
    if (!q.success) return reply.code(400).send({ errore: 'email mancante o non valida' })
    const email = normalizzaEmail(q.data.email)

    const righe = await db<{
      id: string; numero: string; subject: string | null; state: string; canale: string
      brand: string | null; ordine: string | null; aperto_il: Date; ultimo_messaggio_il: Date | null
    }[]>`
      select t.id, t.numero::text as numero, t.subject, t.state, ca.kind as canale,
             ca.display_name as brand,
             coalesce(o.shopify_name, o.external_order_id) as ordine,
             t.created_at as aperto_il,
             (select max(m.sent_at) from message m
               where m.thread_id = t.id and not m.interno and m.author_kind in ('customer', 'agent')
             ) as ultimo_messaggio_il
      from thread t
      join channel_account ca on ca.id = t.account_id
      left join "order" o on o.id = t.order_id
      where ${delCliente(email)}
      order by coalesce(t.last_inbound_at, t.created_at) desc
      limit ${MASSIMO_TICKET}
    `
    return reply.send({
      ticket: righe.map((r) => {
        const stato = statoPerCliente(r.state)
        return {
          id: r.id,
          numero: r.numero,
          oggetto: r.subject,
          stato,
          stato_etichetta: ETICHETTA_STATO[stato],
          canale: r.canale,
          brand: r.brand,
          ordine: r.ordine,
          aperto_il: r.aperto_il,
          ultimo_messaggio_il: r.ultimo_messaggio_il,
        }
      }),
    })
  })

  app.get('/clienti/ticket/:id', async (req, reply) => {
    if (!autorizzato(req, reply)) return
    const q = query.safeParse(req.query)
    const { id } = req.params as { id: string }
    if (!q.success || !z.string().uuid().safeParse(id).success) {
      return reply.code(400).send({ errore: 'richiesta non valida' })
    }
    const email = normalizzaEmail(q.data.email)

    const [t] = await db<{ id: string; numero: string; subject: string | null; state: string; canale: string; ordine: string | null; aperto_il: Date }[]>`
      select t.id, t.numero::text as numero, t.subject, t.state, ca.kind as canale,
             coalesce(o.shopify_name, o.external_order_id) as ordine, t.created_at as aperto_il
      from thread t
      join channel_account ca on ca.id = t.account_id
      left join "order" o on o.id = t.order_id
      where t.id = ${id} and ${delCliente(email)}
    `
    // 404 anche se il ticket esiste ma è di un altro: non si rivela niente.
    if (!t) return reply.code(404).send({ errore: 'ticket non trovato' })

    const messaggi = await db<{ id: string; author_kind: string; body_text: string | null; sent_at: Date }[]>`
      select id, author_kind, body_text, sent_at from message
      where thread_id = ${t.id}
        and not interno
        and author_kind in ('customer', 'agent')
        and body_text is not null and body_text <> ''
      order by sent_at asc
      limit ${MASSIMO_MESSAGGI}
    `
    const stato = statoPerCliente(t.state)
    return reply.send({
      id: t.id,
      numero: t.numero,
      oggetto: t.subject,
      stato,
      stato_etichetta: ETICHETTA_STATO[stato],
      canale: t.canale,
      ordine: t.ordine,
      aperto_il: t.aperto_il,
      messaggi: messaggi.map((m) => ({
        id: m.id,
        da: m.author_kind === 'customer' ? 'cliente' : 'assistenza',
        testo: testoPerCliente(m.body_text!, t.canale, m.author_kind),
        data: m.sent_at,
      })),
    })
  })
}
