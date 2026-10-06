import { describe, it, expect, afterEach } from 'vitest'
import Fastify from 'fastify'

import { parseConfig } from '../src/config.js'
import type { Db } from '../src/db/index.js'
import { voceRoutes } from '../src/routes/voce.js'
import { impostaClientPimPerTest } from '../src/connectors/pim/assistenza.js'

const SECRET = 'segreto-di-prova-lungo-almeno-trentadue-caratteri'

/** Il database del Message System: sessioni e righe d'ordine. */
function dbHub(sessioneValida: boolean) {
  const fn = (strings: TemplateStringsArray) => {
    const sql = strings.join('?')
    if (sql.includes('from voice_session')) return Promise.resolve(sessioneValida ? [{ order_id: 'o1' }] : [])
    if (sql.includes('from order_line')) return Promise.resolve([{ sku: 'INB-HF190', titolo: 'Stufetta bagno' }])
    return Promise.resolve([])
  }
  return Object.assign(fn, { json: (x: unknown) => x }) as unknown as Db
}

/** Il PIM: risponde in base alla funzione chiamata e registra i parametri. */
function pimFinto(risposte: Record<string, unknown>) {
  const chiamate: Array<{ funzione: string; valori: unknown[] }> = []
  const fn = (strings: TemplateStringsArray, ...valori: unknown[]) => {
    const sql = strings.join('?')
    const funzione = Object.keys(risposte).find((f) => sql.includes(f)) ?? 'ignota'
    chiamate.push({ funzione, valori })
    return Promise.resolve([{ r: risposte[funzione] ?? null }])
  }
  impostaClientPimPerTest(fn as never)
  return chiamate
}

async function chiama(url: string, corpo: Record<string, unknown>, opzioni: { pim?: boolean; sessione?: boolean } = {}) {
  const env: Record<string, string> = { SUPABASE_DB_URL: 'postgres://prova', ELEVENLABS_TOOL_SECRET: SECRET }
  if (opzioni.pim !== false) env.PIM_DB_URL = 'postgres://pim'
  const config = parseConfig(env)
  if (!config.success) throw new Error('config')
  const app = Fastify()
  await app.register(voceRoutes, { db: dbHub(opzioni.sessione ?? false), config: config.data })
  const r = await app.inject({ method: 'POST', url, headers: { 'x-voice-secret': SECRET }, payload: corpo })
  return { status: r.statusCode, corpo: r.json() as Record<string, unknown> }
}

afterEach(() => impostaClientPimPerTest(null))

describe('strumenti prodotto dal PIM', () => {
  it('cerca-prodotto passa al PIM il bisogno e la famiglia, e restituisce i candidati', async () => {
    const chiamate = pimFinto({
      assistenza_cerca_prodotti: [{ sku: 'INB-HF190', nome: 'Stufetta bagno', marchio: 'M', famiglia: 'Riscaldamento' }],
    })
    const r = await chiama('/voce/strumenti/cerca-prodotto', {
      conversation_id: 'c1',
      testo: 'scaldare il bagno mentre faccio la doccia',
      famiglia: 'Riscaldamento e comfort caldo',
    })
    expect(r.status).toBe(200)
    expect((r.corpo.prodotti as unknown[]).length).toBe(1)
    expect(chiamate[0]!.valori).toEqual(['scaldare il bagno mentre faccio la doccia', 'Riscaldamento e comfort caldo', 5])
    expect(r.corpo.famiglie_disponibili).toBeUndefined()
  })

  it('nessun risultato: restituisce le famiglie vere, per riprovare senza inventarne', async () => {
    pimFinto({ assistenza_cerca_prodotti: [], assistenza_famiglie: [{ famiglia: 'Riscaldamento', categorie: ['Stufe'] }] })
    const r = await chiama('/voce/strumenti/cerca-prodotto', { conversation_id: 'c1', testo: 'astronave' })
    expect(r.corpo.prodotti).toEqual([])
    expect(r.corpo.famiglie_disponibili).toEqual([{ famiglia: 'Riscaldamento', categorie: ['Stufe'] }])
  })

  it('con una sessione verificata propone anche i prodotti dell’ordine', async () => {
    pimFinto({ assistenza_cerca_prodotti: [] , assistenza_famiglie: [] })
    const r = await chiama('/voce/strumenti/cerca-prodotto', { conversation_id: 'c1', session_token: 'tok' }, { sessione: true })
    expect(r.corpo.prodotti_ordine_verificato).toEqual([{ sku: 'INB-HF190', titolo: 'Stufetta bagno' }])
  })

  it('scheda-prodotto inoltra la scheda del PIM così com’è', async () => {
    const scheda = { sku: 'INB-HF190', nome: 'Stufetta', garanzia_mesi: 24, caratteristiche: ['2000 W'] }
    pimFinto({ assistenza_scheda_prodotto: scheda })
    const r = await chiama('/voce/strumenti/scheda-prodotto', { conversation_id: 'c1', sku: 'INB-HF190' })
    expect(r.corpo).toEqual(scheda)
  })

  it('prodotto non attivo o inesistente: lo dice, senza inventare', async () => {
    pimFinto({ assistenza_scheda_prodotto: null })
    const r = await chiama('/voce/strumenti/scheda-prodotto', { conversation_id: 'c1', sku: 'NON-ESISTE' })
    expect(r.corpo).toEqual({ errore: 'prodotto_non_trovato' })
  })

  it('problemi-prodotto restituisce i problemi noti', async () => {
    const problemi = [{ sintomo: 'Non fa vapore', soluzione: 'Decalcificare', sicurezza: false }]
    pimFinto({ assistenza_problemi_prodotto: problemi })
    const r = await chiama('/voce/strumenti/problemi-prodotto', { conversation_id: 'c1', sku: 'INB-FERRO' })
    expect(r.corpo).toEqual({ problemi })
  })

  it('senza PIM configurato: servizio non disponibile, così l’agente apre un ticket', async () => {
    const r = await chiama('/voce/strumenti/scheda-prodotto', { conversation_id: 'c1', sku: 'X' }, { pim: false })
    expect(r.status).toBe(503)
    expect(r.corpo).toEqual({ errore: 'servizio_non_disponibile' })
  })
})
