import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

import { creaFornitoreToken } from '../src/connectors/shopify/token.js'
import type { Config } from '../src/config.js'

const log = { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} }

const base = {
  SUPABASE_DB_URL: 'postgresql://x',
  SHOPIFY_SHOP: 'inshopping-10.myshopify.com',
  PORT: 3000,
  LOG_LEVEL: 'info',
  NODE_ENV: 'test',
} as unknown as Config

function rispostaOk(token = 'shpca_abc', expires = 86399) {
  return new Response(
    JSON.stringify({ access_token: token, scope: 'read_orders,read_products', expires_in: expires }),
    { status: 200 },
  )
}

beforeEach(() => vi.useFakeTimers())
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks() })

describe('token Shopify', () => {
  it('il token statico ha la precedenza e non chiama la rete', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch')
    const dammi = creaFornitoreToken({ ...base, SHOPIFY_ADMIN_TOKEN: 'shpat_statico' } as Config, log)
    expect(await dammi()).toBe('shpat_statico')
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it('scambia client id e secret e mette in cache', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => rispostaOk())
    const dammi = creaFornitoreToken(
      { ...base, SHOPIFY_CLIENT_ID: 'id', SHOPIFY_CLIENT_SECRET: 'seg' } as Config, log)

    expect(await dammi()).toBe('shpca_abc')
    expect(await dammi()).toBe('shpca_abc')
    // due chiamate al fornitore, una sola richiesta di rete
    expect(fetchSpy).toHaveBeenCalledTimes(1)

    const [url, opts] = fetchSpy.mock.calls[0]!
    expect(String(url)).toBe('https://inshopping-10.myshopify.com/admin/oauth/access_token')
    expect(JSON.parse(String((opts as RequestInit).body))).toEqual({
      client_id: 'id', client_secret: 'seg', grant_type: 'client_credentials',
    })
  })

  it('rinnova quando la scadenza si avvicina', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => rispostaOk())
    const dammi = creaFornitoreToken(
      { ...base, SHOPIFY_CLIENT_ID: 'id', SHOPIFY_CLIENT_SECRET: 'seg' } as Config, log)

    await dammi()
    vi.advanceTimersByTime(23 * 60 * 60 * 1000) // 23 ore: ancora valido
    await dammi()
    expect(fetchSpy).toHaveBeenCalledTimes(1)

    vi.advanceTimersByTime(60 * 60 * 1000) // 24 ore: scaduto
    await dammi()
    expect(fetchSpy).toHaveBeenCalledTimes(2)
  })

  it('dieci chiamate in parallelo fanno una sola richiesta', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => rispostaOk())
    const dammi = creaFornitoreToken(
      { ...base, SHOPIFY_CLIENT_ID: 'id', SHOPIFY_CLIENT_SECRET: 'seg' } as Config, log)

    await Promise.all(Array.from({ length: 10 }, () => dammi()))
    expect(fetchSpy).toHaveBeenCalledTimes(1)
  })

  it('spiega per esteso l errore shop_not_permitted', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(async () =>
      new Response('{"error":"shop_not_permitted"}', { status: 401 }))
    const dammi = creaFornitoreToken(
      { ...base, SHOPIFY_CLIENT_ID: 'id', SHOPIFY_CLIENT_SECRET: 'seg' } as Config, log)
    await expect(dammi()).rejects.toThrow(/stessa organizzazione/)
  })

  it('senza credenziali dice quali mancano', async () => {
    const dammi = creaFornitoreToken(base, log)
    await expect(dammi()).rejects.toThrow(/SHOPIFY_CLIENT_ID/)
  })
})
