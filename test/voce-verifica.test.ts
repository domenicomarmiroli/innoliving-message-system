import { describe, it, expect } from 'vitest'
import Fastify from 'fastify'

import { parseConfig } from '../src/config.js'
import type { Db } from '../src/db/index.js'
import { voceRoutes } from '../src/routes/voce.js'
import {
  confrontaCredenziali,
  nomeDiBattesimo,
  riduciRiferimento,
  type OrdineDaVerificare,
} from '../src/core/voce/verifica.js'
import { marchioDaRaw } from '../src/connectors/voce/sessione.js'
import { erroreSoloEmail } from '../src/connectors/shopify/campi.js'
import { daGraphQL, daWebhook } from '../src/connectors/shopify/normalize.js'

describe('riduciRiferimento: il numero dettato e quello in archivio diventano uguali', () => {
  it('Amazon dettato con spazi = Amazon salvato con i trattini', () => {
    expect(riduciRiferimento('407 6086160 1682752')).toBe(riduciRiferimento('407-6086160-1682752'))
  })
  it('cancelletto, minuscole e spazi spariscono', () => {
    expect(riduciRiferimento(' #insh 9065 ')).toBe('INSH9065')
  })
  it('i numeri Mirakl con trattini e trattini bassi restano confrontabili', () => {
    expect(riduciRiferimento('02116_330594516-A')).toBe('02116330594516A')
  })
})

describe('confrontaCredenziali', () => {
  const ordine: OrdineDaVerificare = { id: 'o1', email: 'Mario.Rossi@Esempio.it', cap: '20121' }

  it('nessun ordine: ordine_non_trovato', () => {
    expect(confrontaCredenziali([], { cap: '20121' })).toEqual({ ok: false, motivo: 'ordine_non_trovato' })
  })
  it('basta il CAP giusto, anche dettato con uno spazio', () => {
    expect(confrontaCredenziali([ordine], { cap: '201 21' })).toEqual({ ok: true, ordine })
  })
  it("basta l'email giusta, senza badare alle maiuscole", () => {
    expect(confrontaCredenziali([ordine], { email: ' mario.rossi@esempio.it' })).toEqual({ ok: true, ordine })
  })
  it('basta uno dei due: email sbagliata ma CAP giusto passa', () => {
    expect(confrontaCredenziali([ordine], { email: 'altro@x.it', cap: '20121' }).ok).toBe(true)
  })
  it('dati sbagliati: dati_non_corrispondenti', () => {
    expect(confrontaCredenziali([ordine], { cap: '00100' })).toEqual({ ok: false, motivo: 'dati_non_corrispondenti' })
  })
  it('ordine senza email né CAP in archivio: dati_non_disponibili, non colpa di chi chiama', () => {
    expect(confrontaCredenziali([{ id: 'o2', email: null, cap: null }], { cap: '20121' })).toEqual({
      ok: false,
      motivo: 'dati_non_disponibili',
    })
  })
  it('due ordini con lo stesso numero e gli stessi dati: non si sceglie a caso', () => {
    const r = confrontaCredenziali([ordine, { ...ordine, id: 'o3' }], { cap: '20121' })
    expect(r.ok).toBe(false)
  })
  it('due ordini con lo stesso numero: vince quello i cui dati corrispondono', () => {
    const r = confrontaCredenziali([{ id: 'x', email: null, cap: '00100' }, ordine], { cap: '20121' })
    expect(r).toEqual({ ok: true, ordine })
  })
})

describe('dati restituiti dopo la verifica', () => {
  it('solo il nome di battesimo, mai il cognome', () => {
    expect(nomeDiBattesimo('MARIO ROSSI')).toBe('Mario')
    expect(nomeDiBattesimo(null)).toBeNull()
  })
  it('il marchio dal campo _brand, in forma GraphQL e webhook', () => {
    expect(marchioDaRaw({ customAttributes: [{ key: '_brand', value: 'Marchio A' }] })).toBe('Marchio A')
    expect(marchioDaRaw({ note_attributes: [{ name: '_brand', value: 'Marchio B' }] })).toBe('Marchio B')
    expect(marchioDaRaw({ customAttributes: [] })).toBeNull()
  })
})

describe('email degli ordini Shopify', () => {
  it('letta sia dalla forma GraphQL sia dal webhook', () => {
    expect(daGraphQL({ id: 'gid://shopify/Order/1', name: '#1', email: 'a@b.it' }).email).toBe('a@b.it')
    expect(daWebhook({ name: '#1', email: 'c@d.it' }).email).toBe('c@d.it')
    expect(daWebhook({ name: '#1', contact_email: 'e@f.it' }).email).toBe('e@f.it')
  })
  it("un errore di accesso solo sul campo email non ferma l'allineamento", () => {
    expect(erroreSoloEmail([{ message: 'Access denied for email field.', path: ['orders', 'nodes', 0, 'email'] }])).toBe(true)
    expect(erroreSoloEmail([{ message: 'Throttled' }])).toBe(false)
    expect(erroreSoloEmail([{ message: 'Access denied for email field.' }, { message: 'Throttled' }])).toBe(false)
  })
})

// ---------------------------------------------------------------------
// Rotta: un finto database che risponde in base alla query
// ---------------------------------------------------------------------

const SECRET = 'segreto-di-prova-lungo-almeno-trentadue-caratteri'

interface Scenario {
  tentativiFalliti?: number
  ordini?: Array<Record<string, unknown>>
}

function dbScenario(s: Scenario) {
  const sessioni: unknown[][] = []
  const fn = (strings: TemplateStringsArray, ...valori: unknown[]) => {
    const sql = strings.join('?')
    if (sql.includes('from voice_log')) return Promise.resolve([{ n: s.tentativiFalliti ?? 0 }])
    if (sql.includes('from "order"')) return Promise.resolve(s.ordini ?? [])
    if (sql.includes('insert into voice_session')) sessioni.push(valori)
    return Promise.resolve([])
  }
  return { db: Object.assign(fn, { json: (x: unknown) => x }) as unknown as Db, sessioni }
}

async function chiama(s: Scenario, corpo: Record<string, unknown>) {
  const { db, sessioni } = dbScenario(s)
  const config = parseConfig({ SUPABASE_DB_URL: 'postgres://prova', ELEVENLABS_TOOL_SECRET: SECRET })
  if (!config.success) throw new Error('config')
  const app = Fastify()
  await app.register(voceRoutes, { db, config: config.data })
  const r = await app.inject({
    method: 'POST',
    url: '/voce/strumenti/verifica-cliente',
    headers: { 'x-voice-secret': SECRET },
    payload: corpo,
  })
  return { status: r.statusCode, corpo: r.json() as Record<string, unknown>, sessioni }
}

const ORDINE = {
  id: 'ordine-1',
  channel: 'amazon',
  operator: null,
  email: null,
  cap: '20121',
  nome: 'Mario Rossi',
  raw: { customAttributes: [{ key: '_brand', value: 'Marchio A' }] },
}

describe('POST /voce/strumenti/verifica-cliente', () => {
  it('verificato: token, nome di battesimo, marchio e canale — e la sessione salva solo l\'impronta', async () => {
    const r = await chiama({ ordini: [ORDINE] }, { conversation_id: 'c1', numero_ordine: '407 6086160 1682752', cap: '20121' })
    expect(r.status).toBe(200)
    expect(r.corpo).toMatchObject({ verificato: true, nome: 'Mario', brand: 'Marchio A', canale: 'Amazon' })
    const token = r.corpo.session_token as string
    expect(token.length).toBeGreaterThan(20)
    expect(r.sessioni).toHaveLength(1)
    expect(r.sessioni[0]).not.toContain(token)
    expect(r.sessioni[0]).toContain('ordine-1')
  })

  it('dati sbagliati: nessun dato dell\'ordine nella risposta', async () => {
    const r = await chiama({ ordini: [ORDINE] }, { conversation_id: 'c1', numero_ordine: '4076086160', cap: '00100' })
    expect(r.corpo).toEqual({ verificato: false, motivo: 'dati_non_corrispondenti' })
    expect(r.sessioni).toHaveLength(0)
  })

  it('dopo tre tentativi falliti si blocca, anche con i dati giusti', async () => {
    const r = await chiama(
      { tentativiFalliti: 3, ordini: [ORDINE] },
      { conversation_id: 'c1', numero_ordine: '4076086160', cap: '20121' },
    )
    expect(r.corpo).toEqual({ verificato: false, motivo: 'troppi_tentativi' })
    expect(r.sessioni).toHaveLength(0)
  })

  it('senza email né CAP chiede il dato invece di contare un tentativo', async () => {
    const r = await chiama({ ordini: [ORDINE] }, { conversation_id: 'c1', numero_ordine: '4076086160' })
    expect(r.corpo).toEqual({ verificato: false, motivo: 'dati_mancanti' })
  })

  it('senza conversation_id è una richiesta non valida', async () => {
    const r = await chiama({}, { numero_ordine: '1234', cap: '20121' })
    expect(r.status).toBe(400)
  })
})
