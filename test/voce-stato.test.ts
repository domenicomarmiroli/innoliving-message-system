import { describe, it, expect } from 'vitest'
import Fastify from 'fastify'

import { parseConfig } from '../src/config.js'
import type { Db } from '../src/db/index.js'
import { voceRoutes, entroLimite } from '../src/routes/voce.js'
import { articoliParlati, corriereParlato, dataParlata, statoOrdine } from '../src/core/voce/stato.js'
import { importoParlato } from '../src/connectors/voce/ordine.js'

describe('statoOrdine', () => {
  const oggi = new Date('2026-10-05T10:00:00Z')
  const ieri = new Date('2026-10-04T10:00:00Z')
  const s = (financial_status: string | null, fulfillment_status: string | null, annullato_il: string | null = null) =>
    statoOrdine({ financial_status, fulfillment_status, annullato_il, placed_at: ieri }, oggi)

  it('pagato e non evaso: in preparazione', () => {
    expect(s('paid', 'unfulfilled').stato).toBe('in_preparazione')
  })
  it('evaso: spedito, in entrambe le grafie di Shopify', () => {
    expect(s('paid', 'fulfilled')).toEqual({ stato: 'spedito', spedizione_parziale: false })
    expect(s('PAID', 'FULFILLED').stato).toBe('spedito')
  })
  it('evaso in parte: spedito, con la spedizione parziale dichiarata', () => {
    expect(s('paid', 'partially_fulfilled')).toEqual({ stato: 'spedito', spedizione_parziale: true })
    expect(s('paid', 'partial').spedizione_parziale).toBe(true)
  })
  it('bonifico non ancora arrivato: in attesa di pagamento', () => {
    expect(s('pending', 'unfulfilled').stato).toBe('in_attesa_pagamento')
  })
  it('annullato vince su tutto, anche su un ordine già evaso', () => {
    expect(s('paid', 'fulfilled', '2026-09-01T10:00:00Z').stato).toBe('annullato')
    expect(s('voided', 'unfulfilled').stato).toBe('annullato')
  })
  it('rimborsato per intero', () => {
    expect(s('refunded', 'fulfilled').stato).toBe('rimborsato')
  })
  it('"in preparazione" da settimane non è credibile: stato sconosciuto, non una affermazione', () => {
    const vecchio = { financial_status: 'paid', fulfillment_status: 'unfulfilled', annullato_il: null }
    expect(statoOrdine({ ...vecchio, placed_at: '2026-09-01T10:00:00Z' }, oggi).stato).toBe('sconosciuto')
    expect(statoOrdine({ ...vecchio, placed_at: '2026-10-01T10:00:00Z' }, oggi).stato).toBe('in_preparazione')
    expect(statoOrdine({ ...vecchio, placed_at: null }, oggi).stato).toBe('sconosciuto')
  })
  it('un valore mai visto non diventa uno stato inventato', () => {
    expect(s('paid', 'qualcosa_di_nuovo').stato).toBe('sconosciuto')
  })
  it('non dice mai "consegnato": non abbiamo il dato della consegna', () => {
    for (const f of ['fulfilled', 'partially_fulfilled', 'unfulfilled']) {
      expect(s('paid', f).stato).not.toBe('consegnato')
    }
  })
})

describe('valori da dire al telefono', () => {
  const oggi = new Date('2026-10-05T10:00:00Z')
  it('date come si pronunciano, con l\'anno solo se diverso', () => {
    expect(dataParlata('2026-09-28T08:00:00Z', oggi)).toBe('28 settembre')
    expect(dataParlata('2025-12-24T08:00:00Z', oggi)).toBe('24 dicembre 2025')
    expect(dataParlata(null, oggi)).toBeNull()
  })
  it('la data è quella italiana, non quella UTC', () => {
    // 23:30 UTC del 30 settembre sono già il primo ottobre in Italia.
    expect(dataParlata('2026-09-30T23:30:00Z', oggi)).toBe('1 ottobre')
  })
  it('articoli con la quantità a parole', () => {
    expect(articoliParlati([{ titolo: 'Stufa', quantita: 1 }, { titolo: 'Filtro', quantita: 2 }, { titolo: null, quantita: 1 }])).toEqual([
      'Stufa (1 pezzo)',
      'Filtro (2 pezzi)',
    ])
  })
  it('importi con la virgola e "euro"', () => {
    expect(importoParlato('39.9', 'EUR')).toBe('39,90 euro')
  })
  it('corriere: le grafie diverse dello stesso nome diventano una', () => {
    expect(corriereParlato('brt')).toBe('BRT')
    expect(corriereParlato('GLS Italy')).toBe('GLS Italy')
    expect(corriereParlato(null)).toBeNull()
  })
})

describe('entroLimite', () => {
  it('un lavoro troppo lento diventa un errore, non un silenzio al telefono', async () => {
    await expect(entroLimite(() => new Promise((r) => setTimeout(r, 200)), 20)).rejects.toThrow(/entro 20 ms/)
  })
})

// ---------------------------------------------------------------------

const SECRET = 'segreto-di-prova-lungo-almeno-trentadue-caratteri'

function dbStato(sessioneValida: boolean) {
  const query: string[] = []
  const fn = (strings: TemplateStringsArray) => {
    const sql = strings.join('?')
    query.push(sql)
    if (sql.includes('from voice_session')) return Promise.resolve(sessioneValida ? [{ order_id: 'o1' }] : [])
    if (sql.includes('from order_line')) return Promise.resolve([{ titolo: 'Stufa', quantita: 1 }])
    if (sql.includes('from "order"')) {
      return Promise.resolve([
        {
          channel: 'shopify',
          operator: null,
          placed_at: new Date('2026-09-28T08:00:00Z'),
          financial_status: 'paid',
          fulfillment_status: 'fulfilled',
          carrier: 'brt',
          tracking_number: '123456789',
          reso_richiesto_at: null,
          rimborso_totale: null,
          rimborso_emesso_at: null,
          currency: 'EUR',
          annullato_il: null,
          spedito_il: '2026-09-30T10:00:00Z',
        },
      ])
    }
    return Promise.resolve([])
  }
  return { db: Object.assign(fn, { json: (x: unknown) => x }) as unknown as Db, query }
}

async function chiama(sessioneValida: boolean, corpo: Record<string, unknown>) {
  const { db, query } = dbStato(sessioneValida)
  const config = parseConfig({ SUPABASE_DB_URL: 'postgres://prova', ELEVENLABS_TOOL_SECRET: SECRET })
  if (!config.success) throw new Error('config')
  const app = Fastify()
  await app.register(voceRoutes, { db, config: config.data })
  const r = await app.inject({
    method: 'POST',
    url: '/voce/strumenti/stato-ordine',
    headers: { 'x-voice-secret': SECRET },
    payload: corpo,
  })
  return { status: r.statusCode, corpo: r.json() as Record<string, unknown>, query }
}

describe('POST /voce/strumenti/stato-ordine', () => {
  it('con una sessione valida: stato pronto da dire, senza dati personali', async () => {
    const r = await chiama(true, { conversation_id: 'c1', session_token: 'tok' })
    expect(r.status).toBe(200)
    expect(r.corpo).toMatchObject({
      stato: 'spedito',
      canale: 'sito',
      corriere: 'BRT',
      tracking_disponibile: true,
      articoli: ['Stufa (1 pezzo)'],
      rimborso: null,
    })
    expect(r.corpo.data_spedizione).toMatch(/settembre/)
    const testo = JSON.stringify(r.corpo)
    expect(testo).not.toMatch(/@|indirizzo|email|cap/i)
  })

  it('sessione scaduta o inventata: nessun dato, l\'agente deve rifare la verifica', async () => {
    const r = await chiama(false, { conversation_id: 'c1', session_token: 'inventato' })
    expect(r.corpo).toEqual({ errore: 'sessione_non_valida' })
    expect(r.query.some((q) => q.includes('from "order"'))).toBe(false)
  })

  it('un numero d\'ordine al posto del token non basta', async () => {
    const r = await chiama(true, { conversation_id: 'c1', numero_ordine: 'INSH9065' })
    expect(r.status).toBe(400)
  })
})
