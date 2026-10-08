import { timingSafeEqual } from 'node:crypto'
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import { z } from 'zod'

import type { Config } from '../config.js'
import type { Db } from '../db/index.js'
import { registraChiamataVoce } from '../connectors/voce/registro.js'
import { statoDellOrdine } from '../connectors/voce/ordine.js'
import { apriTicketVoce, contattoEmail } from '../connectors/voce/ticket.js'
import { avviaRegistrazioneGaranzia } from '../connectors/voce/garanzia.js'
import { verificaNomeRichiamata } from '../connectors/voce/richiamate.js'
import { doveAcquistare, type SitiAcquisto } from '../core/voce/acquisto.js'
import {
  cercaProdottiPim,
  famigliePim,
  pimConfigurato,
  problemiProdottoPim,
  schedaProdottoPim,
} from '../connectors/pim/assistenza.js'
import {
  cercaOrdiniPerEmail,
  cercaOrdiniPerRiferimento,
  creaSessione,
  marchioDaRaw,
  ordineDellaSessione,
  tentativiEsauriti,
  type OrdineTrovato,
} from '../connectors/voce/sessione.js'
import { cifrePerCifra, dataParlata } from '../core/voce/stato.js'
import {
  confrontaCredenziali,
  etichettaCanale,
  nomeDiBattesimo,
  ordineRecenteConCap,
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
  // Facoltativo: il cliente del sito può non averlo, e allora servono email E CAP.
  numero_ordine: testoFacoltativo(100),
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

// ElevenLabs passa le variabili dinamiche non ancora valorizzate come
// stringa vuota o col segnaposto letterale: per noi valgono "assente".
const tokenFacoltativo = z
  .string()
  .max(200)
  .nullable()
  .optional()
  .transform((v) => (v && v.trim() && !v.includes('{{') ? v.trim() : null))

const corpoTicket = z.object({
  conversation_id: z.string().trim().min(1).max(200),
  incidente_sicurezza: z.boolean().nullable().optional(),
  session_token: tokenFacoltativo,
  categoria: z.enum(['spedizione', 'difetto_prodotto', 'reso', 'garanzia', 'info', 'altro']).default('altro'),
  priorita: z.enum(['normale', 'alta']).default('normale'),
  descrizione: z.string().trim().min(1).max(5000),
  prodotto: testoFacoltativo(300),
  nome: testoFacoltativo(200),
  contatto_richiamata: z.string().trim().min(3).max(200),
  caller_number: tokenFacoltativo,
  // Per categoria 'garanzia': il marchio del prodotto, che sceglie il
  // portale garanzie a cui mandare il cliente (canale garanzia-<marchio>).
  // Non 'brand': in ElevenLabs {{brand}} è già il marchio del numero chiamato.
  marchio: z
    .string()
    .trim()
    .toLowerCase()
    .max(40)
    .nullable()
    .optional()
    .transform((v) => (v && /^[a-z0-9-]+$/.test(v) ? v : null)),
})

const corpoCercaProdotto = z.object({
  conversation_id: z.string().trim().min(1).max(200),
  // Nome, codice, EAN o il bisogno del cliente con le sue parole.
  testo: testoFacoltativo(300),
  famiglia: testoFacoltativo(100),
  session_token: tokenFacoltativo,
})

const corpoSku = z.object({
  conversation_id: z.string().trim().min(1).max(200),
  sku: z.string().trim().min(1).max(100),
})

const corpoSessione = z.object({
  conversation_id: z.string().trim().min(1).max(200),
  session_token: z.string().trim().min(1).max(200),
})

/**
 * Oltre questo tempo l'agente riceve "servizio non disponibile" invece di
 * lasciare il cliente in silenzio al telefono: la regola del documento è
 * 4 secondi per strumento, qui c'è il margine per la rete.
 */
export const LIMITE_MS = 3500

export async function entroLimite<T>(lavoro: () => Promise<T>, ms = LIMITE_MS): Promise<T> {
  let timer: NodeJS.Timeout | undefined
  const scadenza = new Promise<never>((_, rifiuta) => {
    timer = setTimeout(() => rifiuta(new Error(`nessuna risposta entro ${ms} ms`)), ms)
  })
  try {
    return await Promise.race([lavoro(), scadenza])
  } finally {
    clearTimeout(timer)
  }
}

function richiestaNonValida(req: FastifyRequest, reply: FastifyReply, errore: z.ZodError) {
  impostaEsitoVoce(req, 'richiesta_non_valida')
  return reply.code(400).send({
    errore: 'richiesta_non_valida',
    dettagli: errore.issues.map((i) => `${i.path.join('.')}: ${i.message}`),
  })
}

function guasto(req: FastifyRequest, reply: FastifyReply, errore: unknown, messaggio: string) {
  req.log.error({ err: errore instanceof Error ? errore.message : String(errore) }, messaggio)
  impostaEsitoVoce(req, 'errore')
  return reply.code(503).send({ errore: 'servizio_non_disponibile' })
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
    if (!analizzato.success) return richiestaNonValida(req, reply, analizzato.error)
    const dati = analizzato.data

    if ((!dati.email && !dati.cap) || (!dati.numero_ordine && !(dati.email && dati.cap))) {
      // Non conta come tentativo: manca una domanda, non una risposta sbagliata.
      impostaEsitoVoce(req, 'dati_mancanti')
      return reply.send({ verificato: false, motivo: 'dati_mancanti' })
    }

    try {
      const risposta = await entroLimite(async () => {
        if (await tentativiEsauriti(db, dati.conversation_id)) {
          return { esito: 'troppi_tentativi', corpo: { verificato: false, motivo: 'troppi_tentativi' } }
        }

        let ordine: OrdineTrovato
        if (dati.numero_ordine) {
          const ordini = await cercaOrdiniPerRiferimento(db, riduciRiferimento(dati.numero_ordine))
          const esito = confrontaCredenziali(ordini, { email: dati.email, cap: dati.cap })
          if (!esito.ok) {
            return { esito: esito.motivo, corpo: { verificato: false, motivo: esito.motivo } }
          }
          ordine = ordini.find((o) => o.id === esito.ordine.id)!
        } else {
          // Senza numero: email E CAP devono corrispondere, e vale l'ordine
          // più recente fra quelli che li hanno entrambi.
          const ordini = await cercaOrdiniPerEmail(db, dati.email!)
          const scelto = ordineRecenteConCap(ordini, dati.cap!)
          if (!scelto.ok) {
            return { esito: scelto.motivo, corpo: { verificato: false, motivo: scelto.motivo } }
          }
          ordine = ordini.find((o) => o.id === scelto.ordine.id)!
        }

        const token = await creaSessione(db, dati.conversation_id, ordine.id)
        return {
          esito: 'verificato',
          corpo: {
            verificato: true,
            session_token: token,
            nome: nomeDiBattesimo(ordine.nome),
            brand: marchioDaRaw(ordine.raw),
            canale: etichettaCanale(ordine.channel, ordine.operator),
            // Per confermare col cliente di quale ordine si parla, soprattutto
            // quando è stato trovato dall'email.
            numero_ordine: ordine.riferimento,
            data_ordine: dataParlata(ordine.placed_at),
          },
        }
      })
      impostaEsitoVoce(req, risposta.esito)
      return reply.send(risposta.corpo)
    } catch (errore) {
      return guasto(req, reply, errore, 'verifica cliente fallita')
    }
  })

  // --- Fase 3: stato dell'ordine verificato --------------------------------
  // L'ordine si ricava SOLO dal token della verifica: questo strumento non
  // accetta un numero d'ordine, così l'agente non può chiedere di un
  // ordine diverso da quello di chi ha superato la verifica.
  app.post('/voce/strumenti/stato-ordine', async (req, reply) => {
    const analizzato = corpoSessione.safeParse(req.body)
    if (!analizzato.success) return richiestaNonValida(req, reply, analizzato.error)

    try {
      const risposta = await entroLimite(async () => {
        const orderId = await ordineDellaSessione(db, analizzato.data.session_token)
        if (!orderId) return { esito: 'sessione_non_valida', corpo: { errore: 'sessione_non_valida' } }
        const stato = await statoDellOrdine(db, orderId)
        if (!stato) return { esito: 'ordine_non_trovato', corpo: { errore: 'ordine_non_trovato' } }
        return { esito: stato.stato, corpo: stato }
      })
      impostaEsitoVoce(req, risposta.esito)
      return reply.send(risposta.corpo)
    } catch (errore) {
      return guasto(req, reply, errore, 'stato ordine fallito')
    }
  })

  // --- Richiamata: chi ha risposto è la persona giusta? ---------------------
  // Solo per l'agente delle richiamate. Il confronto si fa qui e restituisce
  // un esito, mai i nomi in archivio.
  app.post('/voce/strumenti/verifica-nome', async (req, reply) => {
    const analizzato = z
      .object({ conversation_id: z.string().trim().min(1).max(200), nome: z.string().trim().min(1).max(200) })
      .safeParse(req.body)
    if (!analizzato.success) return richiestaNonValida(req, reply, analizzato.error)
    try {
      const risposta = await entroLimite(() =>
        verificaNomeRichiamata(db, analizzato.data.conversation_id, analizzato.data.nome),
      )
      impostaEsitoVoce(req, risposta.esito)
      return reply.send(risposta)
    } catch (errore) {
      return guasto(req, reply, errore, 'verifica nome fallita')
    }
  })

  // --- Fase 4: apertura ticket ------------------------------------------------
  // Funziona anche senza verifica (il cliente può avere un problema che non
  // riguarda un ordine, o non ricordarne il numero): in quel caso il
  // ticket nasce senza ordine e lo dice. Un token non valido non blocca:
  // vale come "non verificato", perché perdere la richiesta del cliente
  // sarebbe peggio.
  app.post('/voce/strumenti/crea-ticket', async (req, reply) => {
    const analizzato = corpoTicket.safeParse(req.body)
    if (!analizzato.success) return richiestaNonValida(req, reply, analizzato.error)
    const dati = analizzato.data

    try {
      const risposta = await entroLimite(async () => {
        const orderId = dati.session_token ? await ordineDellaSessione(db, dati.session_token) : null
        const [ordine] = orderId
          ? await db<{ riferimento: string }[]>`
              select coalesce(shopify_name, external_order_id) as riferimento from "order" where id = ${orderId}
            `
          : []
        const ticket = await apriTicketVoce(db, config, {
          conversation_id: dati.conversation_id,
          order_id: orderId,
          riferimento_ordine: ordine?.riferimento ?? null,
          categoria: dati.categoria,
          priorita: dati.priorita,
          incidente_sicurezza: dati.incidente_sicurezza ?? null,
          descrizione: dati.descrizione,
          prodotto: dati.prodotto,
          nome: dati.nome,
          contatto_richiamata: dati.contatto_richiamata,
          numero_chiamante: dati.caller_number,
        })
        // Garanzia segnalata al telefono: email al cliente con il link al
        // portale del brand. Si decide qui (una query veloce) e si spedisce
        // dopo aver risposto, così la telefonata non aspetta il server di posta.
        const email = contattoEmail(dati.contatto_richiamata)
        const [portale] =
          dati.categoria === 'garanzia' && dati.marchio && email && ticket.nuovo && !ticket.esistente
            ? await db<{ ok: boolean }[]>`
                select true as ok from channel_account
                where code = ${`garanzia-${dati.marchio}`} and active and config ? 'portale_url'
              `
            : []
        if (portale) {
          setImmediate(() => {
            void avviaRegistrazioneGaranzia(db, req.log, config, {
              thread_id: ticket.thread_id,
              numero: String(ticket.numero),
              email,
              nome: dati.nome,
              brand: dati.marchio!,
              prodotto: dati.prodotto,
            })
          })
        }
        return {
          esito: ticket.esistente ? 'ticket_esistente_aggiornato' : ticket.nuovo ? 'ticket_aperto' : 'ticket_aggiornato',
          corpo: {
            ticket_numero: String(ticket.numero),
            ticket_numero_da_dettare: cifrePerCifra(ticket.numero),
            // true = la richiesta è stata aggiunta a una pratica già aperta
            // su quest'ordine: l'agente lo dice al cliente invece di
            // presentarla come nuova.
            ticket_esistente: ticket.esistente,
            // true = il cliente riceve un'email con il link per registrare il
            // prodotto sul portale garanzie (l'agente glielo dice).
            email_registrazione_garanzia: Boolean(portale),
            messaggio: ticket.esistente
              ? `Aggiunto alla pratica ${ticket.numero} già aperta per quest'ordine`
              : `Ticket ${ticket.numero} ${ticket.nuovo ? 'aperto' : 'aggiornato'}`,
          },
        }
      })
      impostaEsitoVoce(req, risposta.esito)
      return reply.send(risposta.corpo)
    } catch (errore) {
      return guasto(req, reply, errore, 'apertura ticket telefonico fallita')
    }
  })

  // --- Prodotti dal PIM: informazioni di primo livello -----------------------
  // Solo dati del PIM, già pronti: l'agente non deve integrarli con ciò
  // che "sa". Se il PIM non risponde, 503 come ogni guasto, e l'agente
  // apre un ticket.
  const senzaPim = (req: FastifyRequest, reply: FastifyReply) => {
    impostaEsitoVoce(req, 'pim_non_configurato')
    return reply.code(503).send({ errore: 'servizio_non_disponibile' })
  }

  app.post('/voce/strumenti/cerca-prodotto', async (req, reply) => {
    const analizzato = corpoCercaProdotto.safeParse(req.body)
    if (!analizzato.success) return richiestaNonValida(req, reply, analizzato.error)
    if (!pimConfigurato(config)) return senzaPim(req, reply)
    const dati = analizzato.data

    try {
      const risposta = await entroLimite(async () => {
        // Il cliente già verificato parla quasi sempre di ciò che ha
        // comprato: quei prodotti vengono proposti per primi.
        const orderId = dati.session_token ? await ordineDellaSessione(db, dati.session_token) : null
        const prodottiOrdine = orderId
          ? await db<{ sku: string | null; titolo: string | null }[]>`
              select sku, titolo from order_line where order_id = ${orderId} and sku is not null
            `
          : []
        const prodotti = dati.testo ? await cercaProdottiPim(config, dati.testo, dati.famiglia, 5) : []
        const famiglie = prodotti.length === 0 ? await famigliePim(config) : undefined
        return {
          esito: prodotti.length > 0 ? 'trovati' : 'nessun_risultato',
          corpo: {
            prodotti,
            ...(prodottiOrdine.length > 0 ? { prodotti_ordine_verificato: prodottiOrdine } : {}),
            ...(famiglie ? { famiglie_disponibili: famiglie } : {}),
          },
        }
      })
      impostaEsitoVoce(req, risposta.esito)
      return reply.send(risposta.corpo)
    } catch (errore) {
      return guasto(req, reply, errore, 'ricerca prodotto nel PIM fallita')
    }
  })

  app.post('/voce/strumenti/scheda-prodotto', async (req, reply) => {
    const analizzato = corpoSku.safeParse(req.body)
    if (!analizzato.success) return richiestaNonValida(req, reply, analizzato.error)
    if (!pimConfigurato(config)) return senzaPim(req, reply)

    try {
      const [scheda, [siti]] = await entroLimite(() =>
        Promise.all([
          schedaProdottoPim(config, analizzato.data.sku),
          db<{ value: SitiAcquisto }[]>`select value from app_config where key = 'voce_siti_acquisto'`,
        ]),
      )
      if (!scheda) {
        impostaEsitoVoce(req, 'prodotto_non_trovato')
        return reply.send({ errore: 'prodotto_non_trovato' })
      }
      impostaEsitoVoce(req, 'trovato')
      // I siti vengono dati con la scheda: l'agente non deve ricordarsi
      // quale sito va con quale marchio.
      const marchio = typeof scheda.marchio === 'string' ? scheda.marchio : null
      return reply.send({ ...scheda, dove_acquistare: doveAcquistare(siti?.value, marchio) })
    } catch (errore) {
      return guasto(req, reply, errore, 'scheda prodotto dal PIM fallita')
    }
  })

  app.post('/voce/strumenti/problemi-prodotto', async (req, reply) => {
    const analizzato = corpoSku.safeParse(req.body)
    if (!analizzato.success) return richiestaNonValida(req, reply, analizzato.error)
    if (!pimConfigurato(config)) return senzaPim(req, reply)

    try {
      const problemi = await entroLimite(() => problemiProdottoPim(config, analizzato.data.sku))
      impostaEsitoVoce(req, problemi.length > 0 ? 'problemi_trovati' : 'nessun_problema_noto')
      return reply.send({ problemi })
    } catch (errore) {
      return guasto(req, reply, errore, 'problemi noti dal PIM falliti')
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
