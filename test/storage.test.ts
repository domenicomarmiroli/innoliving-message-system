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
