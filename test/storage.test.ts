import { describe, it, expect, vi, afterEach } from 'vitest'
import { caricaAllegato, scaricaAllegato } from '../src/core/storage.js'
import type { Config } from '../src/config.js'

const config = {
  SUPABASE_URL: 'https://esempio.supabase.co',
  SUPABASE_SERVICE_ROLE_KEY: 'chiave',
} as Config

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('storage — percorsi con caratteri speciali', () => {
  it('codifica gli spazi nel nome file quando carica', async () => {
    const chiamate: string[] = []
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        chiamate.push(url)
        return new Response(null, { status: 200 })
      }),
    )

    await caricaAllegato(config, 'account/abc-Screenshot 2026-08-26 173654.png', Buffer.from('x'), 'image/png')

    expect(chiamate[0]).toContain('abc-Screenshot%202026-08-26%20173654.png')
    expect(chiamate[0]).not.toContain(' ')
  })

  it('codifica gli spazi anche quando scarica', async () => {
    const chiamate: string[] = []
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        chiamate.push(url)
        return new Response(new Uint8Array([1, 2, 3]), { status: 200 })
      }),
    )

    await scaricaAllegato(config, 'interfaccia/agente/1787758662155-Screenshot 2026-08-26 173654.png')

    expect(chiamate[0]).toContain('Screenshot%202026-08-26%20173654.png')
    expect(chiamate[0]).not.toContain(' ')
  })

  it('manda sempre apikey oltre ad Authorization, sia in carica che in scarica', async () => {
    const chiamate: { url: string; init?: RequestInit }[] = []
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string, init?: RequestInit) => {
        chiamate.push({ url, init })
        return new Response(new Uint8Array([1]), { status: 200 })
      }),
    )

    await caricaAllegato(config, 'account/file.png', Buffer.from('x'), 'image/png')
    await scaricaAllegato(config, 'account/file.png')

    for (const { init } of chiamate) {
      const headers = init?.headers as Record<string, string>
      expect(headers.apikey).toBe('chiave')
      expect(headers.Authorization).toBe('Bearer chiave')
    }
  })

  it('non tocca le barre che separano le cartelle', async () => {
    const chiamate: string[] = []
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        chiamate.push(url)
        return new Response(new Uint8Array([1]), { status: 200 })
      }),
    )

    await scaricaAllegato(config, 'interfaccia/agente con spazio/file.png')

    expect(chiamate[0]).toBe(
      'https://esempio.supabase.co/storage/v1/object/allegati/interfaccia/agente%20con%20spazio/file.png',
    )
  })
})
