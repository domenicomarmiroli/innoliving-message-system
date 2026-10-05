import { describe, it, expect } from 'vitest'
import Fastify from 'fastify'

import { parseConfig, type Config } from '../src/config.js'
import type { Db } from '../src/db/index.js'
import { voceRoutes, nomeStrumento } from '../src/routes/voce.js'
import { oscuraTesto, sanificaPerRegistro } from '../src/core/voce/oscura.js'

const SECRET = 'segreto-di-prova-lungo-almeno-trentadue-caratteri'

function configDiProva(extra: Record<string, string> = {}): Config {
  const esito = parseConfig({ SUPABASE_DB_URL: 'postgres://prova', ELEVENLABS_TOOL_SECRET: SECRET, ...extra })
  if (!esito.success) throw new Error(esito.error.message)
  return esito.data
}

interface Scrittura {
  sql: string
  valori: unknown[]
}

/**
 * Un finto postgres.js: registra ogni query. Le insert in voice_log
 * avvengono dopo la risposta, quindi il test aspetta la scrittura invece
 * di leggerla subito dopo `inject`.
 */
function dbFinto(opzioni: { selectFallisce?: boolean } = {}) {
  const scritture: Scrittura[] = []
  let avvisa: (() => void) | null = null
  const fn = (strings: TemplateStringsArray, ...valori: unknown[]) => {
    const sql = strings.join('?')
    if (sql.includes('select 1') && opzioni.selectFallisce) return Promise.reject(new Error('giù'))
    scritture.push({ sql, valori })
    if (sql.includes('voice_log')) avvisa?.()
    return Promise.resolve([])
  }
  const db = Object.assign(fn, { json: (x: unknown) => x }) as unknown as Db
  const prossimoRegistro = () =>
    new Promise<Scrittura>((risolvi) => {
      avvisa = () => risolvi(scritture.filter((s) => s.sql.includes('voice_log')).at(-1)!)
    })
  return { db, scritture, prossimoRegistro }
}

async function server(db: Db, config = configDiProva()) {
  const app = Fastify()
  await app.register(voceRoutes, { db, config })
  return app
}

describe('rotte /voce: autenticazione', () => {
  it('senza secret risponde 401 e registra il rifiuto', async () => {
    const { db, prossimoRegistro } = dbFinto()
    const app = await server(db)
    const registro = prossimoRegistro()

    const r = await app.inject({ method: 'GET', url: '/voce/health' })

    expect(r.statusCode).toBe(401)
    const riga = await registro
    expect(riga.valori).toContain('health')
    expect(riga.valori).toContain(401)
    expect(riga.valori).toContain('non_autorizzato')
  })

  it('con un secret sbagliato risponde 401', async () => {
    const { db } = dbFinto()
    const app = await server(db)
    const r = await app.inject({
      method: 'GET',
      url: '/voce/health',
      headers: { 'x-voice-secret': SECRET.slice(0, -1) + 'X' },
    })
    expect(r.statusCode).toBe(401)
  })

  it('con il secret giusto risponde 200 e registra la chiamata', async () => {
    const { db, prossimoRegistro } = dbFinto()
    const app = await server(db)
    const registro = prossimoRegistro()

    const r = await app.inject({
      method: 'GET',
      url: '/voce/health?conversation_id=conv_123',
      headers: { 'x-voice-secret': SECRET },
    })

    expect(r.statusCode).toBe(200)
    expect(r.json()).toEqual({ ok: true })
    const riga = await registro
    expect(riga.valori).toContain('conv_123')
    expect(riga.valori).toContain(200)
    expect(riga.valori).toContain('ok')
  })

  it('database irraggiungibile: 503 con un errore che l\'agente può dire', async () => {
    const { db } = dbFinto({ selectFallisce: true })
    const app = await server(db)
    const r = await app.inject({ method: 'GET', url: '/voce/health', headers: { 'x-voice-secret': SECRET } })
    expect(r.statusCode).toBe(503)
    expect(r.json()).toEqual({ ok: false, errore: 'servizio_non_disponibile' })
  })

  it('senza ELEVENLABS_TOOL_SECRET le rotte non esistono', async () => {
    const { db } = dbFinto()
    const config = parseConfig({ SUPABASE_DB_URL: 'postgres://prova' })
    if (!config.success) throw new Error('config')
    const app = await server(db, config.data)
    const r = await app.inject({ method: 'GET', url: '/voce/health', headers: { 'x-voice-secret': SECRET } })
    expect(r.statusCode).toBe(404)
  })

  it('un secret troppo corto è rifiutato già dalla configurazione', () => {
    expect(parseConfig({ SUPABASE_DB_URL: 'x', ELEVENLABS_TOOL_SECRET: 'corto' }).success).toBe(false)
  })
})

describe('nomeStrumento', () => {
  it('prende l\'ultimo pezzo del percorso', () => {
    expect(nomeStrumento('/voce/strumenti/stato-ordine')).toBe('stato-ordine')
    expect(nomeStrumento('/voce/health?x=1')).toBe('health')
  })
})

describe('registro voce: nessun dato personale in chiaro', () => {
  it('maschera i campi riconosciuti dal nome, lasciando una traccia utile', () => {
    const r = sanificaPerRegistro({
      conversation_id: 'conv_1',
      order_number: '#1234',
      email: 'mario.rossi@gmail.com',
      postal_code: '20121',
      caller_number: '+39 347 123 4567',
      session_token: 'abcdef',
      nome: 'Mario',
      indirizzo: 'Via Roma 1',
    })
    expect(r).toEqual({
      conversation_id: 'conv_1',
      order_number: '#1234',
      email: 'm***@gmail.com',
      postal_code: '20***',
      caller_number: '***567',
      session_token: '[oscurato]',
      nome: 'M.',
      indirizzo: '[indirizzo oscurato]',
    })
  })

  it('trova email e telefoni dentro il testo libero', () => {
    const t = oscuraTesto('Richiamatemi al 347 1234567 oppure al 02 12345678, o scrivete a mario@esempio.it')
    expect(t).not.toMatch(/1234567|12345678|mario@/)
    expect(t).toContain('***567')
    expect(t).toContain('m***@esempio.it')
  })

  it('non scambia un numero d\'ordine Amazon per un telefono', () => {
    const t = oscuraTesto('Ordine 305-1234567-7654321 e ordine 403-1049451-9270721')
    expect(t).toBe('Ordine 305-1234567-7654321 e ordine 403-1049451-9270721')
  })

  it('applica anche la redazione di IBAN e carte', () => {
    const t = oscuraTesto('Rimborsate su IT60X0542811101000000123456 grazie')
    expect(t).toContain('[IBAN oscurato]')
  })

  it('scende negli oggetti annidati e negli array', () => {
    const r = sanificaPerRegistro({ dati: [{ email: 'a@b.it' }, 'chiamami al 3471234567'] }) as {
      dati: [{ email: string }, string]
    }
    expect(r.dati[0].email).toBe('a***@b.it')
    expect(r.dati[1]).toBe('chiamami al ***567')
  })
})
