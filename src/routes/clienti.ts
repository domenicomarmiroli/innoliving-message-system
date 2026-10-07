import { timingSafeEqual } from 'node:crypto'
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import { z } from 'zod'

import type { Config } from '../config.js'
import type { Db } from '../db/index.js'
import { ETICHETTA_STATO, normalizzaEmail, statoPerCliente, testoPerCliente } from '../core/clienti/area.js'
import { scaricaAllegato, storageConfigurato } from '../core/storage.js'
import {
  TAG_ATTESA_REGISTRAZIONE,
  TAG_GARANZIA_REGISTRATA,
  chiaveValida,
  testoRegistrazione,
} from '../core/garanzia/collegamento.js'
import {
  LIMITE_CORPO_RICHIESTA,
  preparaAllegatiCliente,
  schemaAllegato,
  validaAllegati,
} from '../connectors/clienti/allegati.js'

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
      in_attesa_garanzia: boolean
    }[]>`
      select t.id, t.numero::text as numero, t.subject, t.state, ca.kind as canale,
             ${TAG_ATTESA_REGISTRAZIONE} = any(t.tags) as in_attesa_garanzia,
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
          // true = aperto al telefono per un prodotto in garanzia, aspetta che
          // il cliente registri il prodotto sul portale.
          in_attesa_garanzia: r.in_attesa_garanzia,
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
        and (coalesce(body_text, '') <> '' or exists (select 1 from attachment a where a.message_id = message.id))
      order by sent_at asc
      limit ${MASSIMO_MESSAGGI}
    `
    const allegati = messaggi.length
      ? await db<{ id: string; message_id: string; nome_file: string; mime: string | null; dimensione_byte: number | null }[]>`
          select id, message_id, nome_file, mime, dimensione_byte from attachment
          where message_id = any(${messaggi.map((m) => m.id)}) and storage_path is not null
          order by created_at
        `
      : []
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
        testo: m.body_text ? testoPerCliente(m.body_text, t.canale, m.author_kind) : '',
        data: m.sent_at,
        allegati: allegati
          .filter((a) => a.message_id === m.id)
          .map((a) => ({ id: a.id, nome_file: a.nome_file, mime: a.mime, dimensione_byte: a.dimensione_byte })),
      })),
    })
  })

  // --- Un allegato del ticket, per il sito che lo mostra al cliente --------
  // Il sito fa da tramite (stesso token, stessa email dal profilo): il
  // bucket è privato e il browser del cliente non deve vederne le chiavi.
  app.get('/clienti/ticket/:id/allegati/:allegato', async (req, reply) => {
    if (!autorizzato(req, reply)) return
    const q = query.safeParse(req.query)
    const { id, allegato } = req.params as { id: string; allegato: string }
    const uuid = z.string().uuid()
    if (!q.success || !uuid.safeParse(id).success || !uuid.safeParse(allegato).success) {
      return reply.code(400).send({ errore: 'richiesta non valida' })
    }
    const email = normalizzaEmail(q.data.email)
    const [a] = await db<{ nome_file: string; mime: string | null; storage_path: string }[]>`
      select a.nome_file, a.mime, a.storage_path
      from attachment a
      join message m on m.id = a.message_id
      join thread t on t.id = m.thread_id
      join channel_account ca on ca.id = t.account_id
      left join "order" o on o.id = t.order_id
      where a.id = ${allegato} and t.id = ${id}
        and not m.interno and m.author_kind in ('customer', 'agent')
        and a.storage_path is not null
        and ${delCliente(email)}
    `
    if (!a || !storageConfigurato(config)) return reply.code(404).send({ errore: 'allegato non trovato' })
    const byte = await scaricaAllegato(config, a.storage_path)
    return reply
      .header('Content-Type', a.mime ?? 'application/octet-stream')
      .header('Content-Disposition', `inline; filename*=UTF-8''${encodeURIComponent(a.nome_file)}`)
      .send(byte)
  })

  // --- Il cliente scrive (testo e/o allegati) dall'area cliente --------------
  const corpoRisposta = z
    .object({
      email: z.string().email(),
      testo: z.string().max(10_000).default(''),
      allegati: z.array(schemaAllegato).max(20).optional(),
      // Un retry di rete con lo stesso valore non duplica il messaggio.
      richiesta_id: z.string().trim().min(1).max(200).optional(),
    })
    .refine((c) => c.testo.trim().length > 0 || (c.allegati?.length ?? 0) > 0, {
      message: 'scrivi un messaggio o allega un file',
    })

  app.post('/clienti/ticket/:id/messaggi', { bodyLimit: LIMITE_CORPO_RICHIESTA }, async (req, reply) => {
    if (!autorizzato(req, reply)) return
    const { id } = req.params as { id: string }
    const c = corpoRisposta.safeParse(req.body)
    if (!c.success || !z.string().uuid().safeParse(id).success) {
      return reply.code(400).send({
        errore: 'richiesta non valida',
        dettagli: c.success ? [] : c.error.issues.map((i) => i.message),
      })
    }
    const email = normalizzaEmail(c.data.email)

    const [t] = await db<{ id: string; numero: string; subject: string | null; account_code: string; sla_minutes: number }[]>`
      select t.id, t.numero::text as numero, t.subject, ca.code as account_code, ca.sla_minutes
      from thread t
      join channel_account ca on ca.id = t.account_id
      left join "order" o on o.id = t.order_id
      where t.id = ${id} and ${delCliente(email)}
    `
    if (!t) return reply.code(404).send({ errore: 'ticket non trovato' })

    let files
    try {
      files = validaAllegati(c.data.allegati ?? [])
    } catch (errore) {
      return reply.code(422).send({ errore: errore instanceof Error ? errore.message : String(errore) })
    }
    const allegati = await preparaAllegatiCliente(config, req.log, t.account_code, files)

    // La nostra risposta deve ripartire dalla stessa casella e restare nella
    // stessa catena email del messaggio precedente del cliente:
    // inviaRisposta() legge casella e References dall'ultimo messaggio del
    // cliente, che da ora è questo.
    const [precedente] = await db<{ raw: Record<string, unknown> | null; rfc822_id: string | null }[]>`
      select raw, rfc822_id from message
      where thread_id = ${t.id} and author_kind = 'customer' and direction = 'in'
      order by sent_at desc limit 1
    `
    const precedenti = precedente?.raw?.['references']
    const riferimenti = [
      ...(Array.isArray(precedenti) ? (precedenti as string[]) : []),
      ...(precedente?.rfc822_id ? [precedente.rfc822_id] : []),
    ]
    const ora = new Date()

    const messaggioId = await db.begin(async (tx) => {
      const [m] = await tx<{ id: string }[]>`
        insert into message (thread_id, direction, author_kind, external_id, body_text, sent_at, raw)
        values (
          ${t.id}, 'in', 'customer', ${c.data.richiesta_id ?? null}, ${c.data.testo.trim()}, ${ora},
          ${tx.json({
            from: email,
            canale: 'area_cliente',
            subject: t.subject,
            casella: precedente?.raw?.['casella'] ?? null,
            references: riferimenti,
          } as never)}
        )
        on conflict (thread_id, external_id) do nothing
        returning id
      `
      if (!m) return null
      for (const a of allegati) {
        await tx`
          insert into attachment (
            message_id, direzione, nome_file, mime, dimensione_byte, checksum, storage_path, larghezza, altezza
          ) values (
            ${m.id}, 'in', ${a.nome_file}, ${a.mime}, ${a.dimensione_byte}, ${a.checksum},
            ${a.storage_path}, ${a.larghezza}, ${a.altezza}
          )
        `
      }
      // Il cliente ha scritto: il ticket torna in coda, con la scadenza
      // ricalcolata da adesso, anche se era chiuso.
      await tx`
        update thread set
          state = 'open',
          last_inbound_at = ${ora},
          due_at = ${new Date(ora.getTime() + t.sla_minutes * 60_000)},
          updated_at = now()
        where id = ${t.id}
      `
      return m.id
    })

    req.log.info(
      { thread_id: t.id, allegati: allegati.length, duplicato: messaggioId === null },
      "messaggio del cliente dall'area cliente",
    )
    return reply.code(200).send({ ok: true, message_id: messaggioId, numero: t.numero })
  })

  // --- Garanzia registrata sul portale: si collega al ticket del telefono ---
  // Il cliente ha chiamato, ha ricevuto l'email con il link e ha registrato
  // il prodotto. Il portale manda qui i dati della garanzia e lo scontrino:
  // il ticket già aperto li riceve come messaggio del cliente e torna in
  // coda all'assistenza. Autorizzato dalla chiave del link (anche se il
  // cliente si è registrato con un'altra email) o dall'email del cliente.
  const corpoGaranzia = z.object({
    email: z.string().email(),
    chiave: z.string().trim().max(100).nullable().optional(),
    // Id della garanzia nel portale: una seconda chiamata per la stessa
    // garanzia non duplica il messaggio.
    garanzia_id: z.string().trim().min(1).max(100),
    garanzia: z.object({
      prodotto: z.string().max(300).nullable().optional(),
      codice: z.string().max(100).nullable().optional(),
      numero_seriale: z.string().max(100).nullable().optional(),
      data_acquisto: z.string().max(40).nullable().optional(),
      garanzia_fino_al: z.string().max(40).nullable().optional(),
      numero_ordine: z.string().max(100).nullable().optional(),
      rivenditore: z.string().max(200).nullable().optional(),
    }),
    allegati: z.array(schemaAllegato).max(20).optional(),
  })

  app.post('/clienti/ticket/:id/garanzia', { bodyLimit: LIMITE_CORPO_RICHIESTA }, async (req, reply) => {
    if (!autorizzato(req, reply)) return
    const { id } = req.params as { id: string }
    const c = corpoGaranzia.safeParse(req.body)
    if (!c.success || !z.string().uuid().safeParse(id).success) {
      return reply.code(400).send({
        errore: 'richiesta non valida',
        dettagli: c.success ? [] : c.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`),
      })
    }
    const email = normalizzaEmail(c.data.email)
    const conChiave = chiaveValida(id, c.data.chiave, chiave!)

    const [t] = await db<{ id: string; numero: string; subject: string | null; account_code: string; sla_minutes: number }[]>`
      select t.id, t.numero::text as numero, t.subject, ca.code as account_code, ca.sla_minutes
      from thread t
      join channel_account ca on ca.id = t.account_id
      left join "order" o on o.id = t.order_id
      where t.id = ${id}
        and (${conChiave} or (${delCliente(email)}))
    `
    if (!t) return reply.code(404).send({ errore: 'ticket non trovato' })

    let files
    try {
      files = validaAllegati(c.data.allegati ?? [])
    } catch (errore) {
      return reply.code(422).send({ errore: errore instanceof Error ? errore.message : String(errore) })
    }
    const allegati = await preparaAllegatiCliente(config, req.log, t.account_code, files)

    const [precedente] = await db<{ raw: Record<string, unknown> | null; rfc822_id: string | null }[]>`
      select raw, rfc822_id from message
      where thread_id = ${t.id} and author_kind = 'customer' and direction = 'in'
      order by sent_at desc limit 1
    `
    const ora = new Date()

    const messaggioId = await db.begin(async (tx) => {
      const [m] = await tx<{ id: string }[]>`
        insert into message (thread_id, direction, author_kind, external_id, body_text, sent_at, raw)
        values (
          ${t.id}, 'in', 'customer', ${`garanzia:${c.data.garanzia_id}`}, ${testoRegistrazione(c.data.garanzia)}, ${ora},
          ${tx.json({
            // Se il cliente scrive dal portale con un'altra email, da qui in
            // poi il ticket compare anche nella sua area con quell'indirizzo.
            from: email,
            canale: 'portale_garanzie',
            subject: t.subject,
            casella: precedente?.raw?.['casella'] ?? null,
            garanzia: c.data.garanzia,
          } as never)}
        )
        on conflict (thread_id, external_id) do nothing
        returning id
      `
      if (!m) return null
      for (const a of allegati) {
        await tx`
          insert into attachment (
            message_id, direzione, nome_file, mime, dimensione_byte, checksum, storage_path, larghezza, altezza
          ) values (
            ${m.id}, 'in', ${a.nome_file}, ${a.mime}, ${a.dimensione_byte}, ${a.checksum},
            ${a.storage_path}, ${a.larghezza}, ${a.altezza}
          )
        `
      }
      // Torna APERTO, in coda all'assistenza, con la scadenza da adesso.
      await tx`
        update thread set
          state = 'open',
          tags = (select array(select distinct x from unnest(tags || array[${TAG_GARANZIA_REGISTRATA}::text, 'garanzia'::text]) x
                  where x <> ${TAG_ATTESA_REGISTRAZIONE})),
          last_inbound_at = ${ora},
          due_at = ${new Date(ora.getTime() + t.sla_minutes * 60_000)},
          updated_at = now()
        where id = ${t.id}
      `
      return m.id
    })

    req.log.info(
      { thread_id: t.id, con_chiave: conChiave, allegati: allegati.length, duplicato: messaggioId === null },
      'garanzia registrata sul portale collegata al ticket',
    )
    return reply.code(200).send({ ok: true, numero: t.numero, thread_id: t.id })
  })

  // --- Anteprima per la conferma nel portale ----------------------------------
  // Arrivando dal link dell'email, il portale mostra "Richiesta n. 12345 del
  // 7 ottobre: è per questo prodotto?" prima che il cliente confermi. Solo
  // con la chiave del link, e solo il minimo: niente conversazione.
  app.get('/clienti/ticket/:id/anteprima', async (req, reply) => {
    if (!autorizzato(req, reply)) return
    const { id } = req.params as { id: string }
    const { chiave: chiaveLink } = (req.query ?? {}) as { chiave?: string }
    if (!z.string().uuid().safeParse(id).success || !chiaveValida(id, chiaveLink, chiave!)) {
      return reply.code(404).send({ errore: 'richiesta non trovata' })
    }
    // `email`: per precompilare l'accesso al portale. Chi ha la chiave ha
    // ricevuto l'email a quell'indirizzo, quindi non rivela niente di nuovo.
    const [t] = await db<{ numero: string; aperto_il: Date; in_attesa_garanzia: boolean; registrata: boolean; prodotto: string | null; email: string | null }[]>`
      select t.numero::text as numero, t.created_at as aperto_il,
             ${TAG_ATTESA_REGISTRAZIONE} = any(t.tags) as in_attesa_garanzia,
             ${TAG_GARANZIA_REGISTRATA} = any(t.tags) as registrata,
             (select m.raw->>'prodotto' from message m
               where m.thread_id = t.id and m.author_kind = 'customer'
               order by m.sent_at asc limit 1) as prodotto,
             (select m.raw->>'from' from message m
               where m.thread_id = t.id and m.author_kind = 'customer' and m.raw->>'from' like '%@%'
               order by m.sent_at asc limit 1) as email
      from thread t where t.id = ${id}
    `
    if (!t) return reply.code(404).send({ errore: 'richiesta non trovata' })
    return reply.send(t)
  })
}
