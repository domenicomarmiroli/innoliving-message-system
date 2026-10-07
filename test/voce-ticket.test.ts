import { describe, it, expect } from 'vitest'
import Fastify from 'fastify'

import { parseConfig } from '../src/config.js'
import type { Db } from '../src/db/index.js'
import { voceRoutes } from '../src/routes/voce.js'
import {
  contattoEmail,
  oggettoTicketVoce,
  tagTicketVoce,
  testoTicketVoce,
  type RichiestaTicketVoce,
} from '../src/connectors/voce/ticket.js'
import { CATEGORIE_INTENTO } from '../src/core/ai/intento.js'

const base: RichiestaTicketVoce = {
  conversation_id: 'conv_1',
  order_id: null,
  riferimento_ordine: null,
  categoria: 'difetto_prodotto',
  priorita: 'normale',
  descrizione: 'La stufa non si accende più',
  prodotto: 'Stufa X',
  nome: 'Mario',
  contatto_richiamata: '3471234567',
  numero_chiamante: null,
}

describe('ticket dal telefono: parti pure', () => {
  it("riconosce un'email come contatto, un telefono no", () => {
    expect(contattoEmail(' Mario@Esempio.it ')).toBe('mario@esempio.it')
    expect(contattoEmail('347 1234567')).toBeNull()
  })

  it('i tag usano la stessa tassonomia della knowledge base, più telefono e priorità', () => {
    const tag = tagTicketVoce('difetto_prodotto', 'alta')
    expect(tag).toEqual(['telefono', 'prodotto-difettoso', 'priorita-alta'])
    for (const c of ['spedizione', 'difetto_prodotto', 'reso', 'garanzia', 'info', 'altro'] as const) {
      expect(CATEGORIE_INTENTO).toContain(tagTicketVoce(c, 'normale')[1])
    }
  })

  it("l'oggetto cita l'ordine solo se il cliente è stato verificato", () => {
    expect(oggettoTicketVoce('reso', 'INSH9065')).toBe('Telefono — reso — ordine INSH9065')
    expect(oggettoTicketVoce('info', null)).toBe('Telefono — informazioni')
  })

  it("il testo dice all'operatore se il cliente era verificato e come ricontattarlo", () => {
    const t = testoTicketVoce(base)
    expect(t).toContain('La stufa non si accende più')
    expect(t).toContain('Contatto per la risposta: 3471234567')
    expect(t).toContain('NON verificato')
    expect(testoTicketVoce({ ...base, order_id: 'o1' })).toContain('verificato sull')
  })
})

// ---------------------------------------------------------------------

const SECRET = 'segreto-di-prova-lungo-almeno-trentadue-caratteri'

function dbTicket(sessioneValida: boolean) {
  const scritture: Array<{ sql: string; valori: unknown[] }> = []
  const fn = (strings: TemplateStringsArray, ...valori: unknown[]) => {
    const sql = strings.join('?')
    scritture.push({ sql, valori })
    if (sql.includes('from voice_session')) return Promise.resolve(sessioneValida ? [{ order_id: 'o1' }] : [])
    if (sql.includes('as riferimento')) return Promise.resolve([{ riferimento: 'INSH9065' }])
    if (sql.includes("kind = 'telefono'")) return Promise.resolve([{ id: 'acc', sla_minutes: 480 }])
    if (sql.includes('insert into thread')) return Promise.resolve([{ id: 't1', numero: '10234', nuovo: true }])
    return Promise.resolve([])
  }
  const db = Object.assign(fn, {
    json: (x: unknown) => x,
    begin: (lavoro: (tx: unknown) => Promise<unknown>) => lavoro(db),
  }) as unknown as Db
  return { db, scritture }
}

async function chiama(sessioneValida: boolean, corpo: Record<string, unknown>) {
  const { db, scritture } = dbTicket(sessioneValida)
  const config = parseConfig({ SUPABASE_DB_URL: 'postgres://prova', ELEVENLABS_TOOL_SECRET: SECRET })
  if (!config.success) throw new Error('config')
  const app = Fastify()
  await app.register(voceRoutes, { db, config: config.data })
  const r = await app.inject({
    method: 'POST',
    url: '/voce/strumenti/crea-ticket',
    headers: { 'x-voice-secret': SECRET },
    payload: corpo,
  })
  return { status: r.statusCode, corpo: r.json() as Record<string, unknown>, scritture }
}

describe('POST /voce/strumenti/crea-ticket', () => {
  const richiesta = {
    conversation_id: 'conv_1',
    categoria: 'difetto_prodotto',
    descrizione: 'La stufa non si accende',
    contatto_richiamata: 'mario@esempio.it',
  }

  it('restituisce il numero breve da dettare al cliente', async () => {
    const r = await chiama(false, richiesta)
    expect(r.status).toBe(200)
    expect(r.corpo).toEqual({ ticket_numero: '10234', ticket_numero_da_dettare: '1 0 2 3 4', ticket_esistente: false, email_registrazione_garanzia: false, messaggio: 'Ticket 10234 aperto' })
  })

  it("con una sessione valida il ticket è legato all'ordine verificato", async () => {
    const r = await chiama(true, { ...richiesta, session_token: 'tok' })
    const thread = r.scritture.find((s) => s.sql.includes('insert into thread'))!
    expect(thread.valori).toContain('o1')
    expect(thread.valori).toContain('Telefono — prodotto difettoso — ordine INSH9065')
  })

  it("un token non valorizzato da ElevenLabs vale come cliente non verificato, non come errore", async () => {
    const r = await chiama(false, { ...richiesta, session_token: '{{session_token}}' })
    expect(r.status).toBe(200)
    expect(r.scritture.some((s) => s.sql.includes('from voice_session'))).toBe(false)
  })

  it("l'email del cliente finisce in raw.from: l'operatore risponde dal ticket come a un'email", async () => {
    const r = await chiama(false, richiesta)
    const messaggio = r.scritture.find((s) => s.sql.includes('insert into message'))!
    const raw = messaggio.valori.find((v) => typeof v === 'object' && v !== null && 'canale' in v) as Record<string, unknown>
    expect(raw.from).toBe('mario@esempio.it')
    expect(raw.canale).toBe('telefono')
  })

  it('senza descrizione o contatto è una richiesta non valida', async () => {
    const r = await chiama(false, { conversation_id: 'c', categoria: 'altro' })
    expect(r.status).toBe(400)
  })
})

describe('notaTelefonata', () => {
  it('nel ticket esistente la telefonata entra come nota riconoscibile', async () => {
    const { notaTelefonata } = await import('../src/connectors/voce/ticket.js')
    expect(notaTelefonata('Non mi è arrivato il pacco.')).toMatch(/^Il cliente ha chiamato l'assistente vocale\.\n\nNon mi è arrivato il pacco\.$/)
  })
})
