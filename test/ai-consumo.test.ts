import { describe, it, expect, afterEach } from 'vitest'

import type { Db } from '../src/db/index.js'
import {
  azzeraMisuraAI,
  BudgetAISuperato,
  costoStimato,
  giornoItaliano,
  impostaMisuraAI,
  prezzoDi,
} from '../src/core/ai/consumo.js'
import { creaProvider } from '../src/core/ai/provider.js'

const conf = { budget_giornaliero_usd: 5, prezzi: { 'claude-haiku-4-5': { input: 1, output: 5 } } }

describe('costo delle chiamate', () => {
  it('riconosce il modello anche con la data in coda', () => {
    expect(prezzoDi(conf, 'claude-haiku-4-5-20251001')).toEqual({ input: 1, output: 5 })
  })
  it('un modello sconosciuto si stima più caro, mai gratis', () => {
    expect(prezzoDi(conf, 'modello-nuovo').output).toBeGreaterThan(5)
  })
  it('una chiamata della traduzione impazzita: 4.000 token in, 2.500 out', () => {
    expect(costoStimato(conf, 'claude-haiku-4-5-20251001', 4000, 2500)).toBeCloseTo(0.0165, 4)
  })
  it('il giorno si conta in ora italiana', () => {
    expect(giornoItaliano(new Date('2026-10-06T22:30:00Z'))).toBe('2026-10-07')
  })
})

// ---------------------------------------------------------------------

function ambiente(spesoOggi: number) {
  const scritture: string[] = []
  const fn = (strings: TemplateStringsArray) => {
    const sql = strings.join('?')
    scritture.push(sql)
    if (sql.includes("key = 'ai_controllo'")) return Promise.resolve([{ value: conf }])
    if (sql.includes('sum(costo_usd)')) return Promise.resolve([{ totale: String(spesoOggi) }])
    return Promise.resolve([])
  }
  const db = Object.assign(fn, { json: (x: unknown) => x }) as unknown as Db
  impostaMisuraAI(db, { info() {}, warn() {}, error() {}, debug() {} })

  let chiamateApi = 0
  globalThis.fetch = (async () => {
    chiamateApi += 1
    return new Response(
      JSON.stringify({
        content: [{ type: 'text', text: 'ok' }],
        model: 'claude-haiku-4-5-20251001',
        stop_reason: 'max_tokens',
        usage: { input_tokens: 4000, output_tokens: 2500 },
      }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    )
  }) as typeof fetch
  return { scritture, chiamateApi: () => chiamateApi }
}

const configAI = { AI_PROVIDER: 'anthropic', ANTHROPIC_API_KEY: 'k', ANTHROPIC_MODEL: 'claude-haiku-4-5-20251001' }
const originale = globalThis.fetch
afterEach(() => {
  globalThis.fetch = originale
  azzeraMisuraAI()
})

describe('tetto giornaliero', () => {
  it('ogni chiamata lascia una riga in ai_uso, con la risposta troncata segnalata', async () => {
    const a = ambiente(0)
    const p = await creaProvider(configAI, undefined, { funzione: 'traduzione_arrivo', sfondo: true })
    await p.completa({ sistema: 's', utente: 'u', max_token: 2500 })
    expect(a.scritture.some((s) => s.includes('insert into ai_uso'))).toBe(true)
  })

  it('superato il tetto, i lavori in background si fermano PRIMA di chiamare l’API', async () => {
    const a = ambiente(5.2)
    const p = await creaProvider(configAI, undefined, { funzione: 'traduzione_arrivo', sfondo: true })
    await expect(p.completa({ sistema: 's', utente: 'u', max_token: 10 })).rejects.toBeInstanceOf(BudgetAISuperato)
    expect(a.chiamateApi()).toBe(0)
    expect(a.scritture.some((s) => s.includes('ingest_anomaly'))).toBe(true)
  })

  it('le azioni di un operatore non si bloccano', async () => {
    const a = ambiente(5.2)
    const p = await creaProvider(configAI, undefined, { funzione: 'bozza', sfondo: false })
    await p.completa({ sistema: 's', utente: 'u', max_token: 10 })
    expect(a.chiamateApi()).toBe(1)
  })
})
