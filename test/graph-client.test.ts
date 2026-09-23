import { describe, it, expect, vi, afterEach } from 'vitest'
import type { Config } from '../src/config.js'
import {
  ClientGraph,
  credenzialiGraphMancanti,
  messaggioChiaro,
  messaggioToken,
} from '../src/connectors/graph/client.js'
import { logger } from '../src/logger.js'

const config = {
  MS_TENANT_ID: 'tenant-di-prova',
  MS_CLIENT_ID: 'client-di-prova',
  MS_CLIENT_SECRET: 'segreto-di-prova',
  MS_MAILBOX: 'casella@esempio.test',
} as Config

afterEach(() => {
  vi.unstubAllGlobals()
})

function risposta(corpo: unknown, stato = 200): Response {
  return new Response(JSON.stringify(corpo), { status: stato })
}

describe('credenziali', () => {
  it('elenca cosa manca, così il log dice cosa impostare su Render', () => {
    expect(credenzialiGraphMancanti({} as Config)).toEqual([
      'MS_TENANT_ID',
      'MS_CLIENT_ID',
      'MS_CLIENT_SECRET',
      'MS_MAILBOX',
    ])
    expect(credenzialiGraphMancanti(config)).toEqual([])
  })
})

describe('ClientGraph — token', () => {
  it('chiede il token con client credentials e lo riusa finché vale', async () => {
    const chiamate: string[] = []
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string, init: RequestInit) => {
        chiamate.push(url)
        if (url.includes('/oauth2/v2.0/token')) {
          const corpo = new URLSearchParams(String(init.body))
          expect(corpo.get('grant_type')).toBe('client_credentials')
          expect(corpo.get('scope')).toBe('https://graph.microsoft.com/.default')
          return risposta({ access_token: 'tok-1', expires_in: 3600 })
        }
        const headers = init.headers as Record<string, string>
        expect(headers.Authorization).toBe('Bearer tok-1')
        return risposta({ value: [] })
      }),
    )

    const client = new ClientGraph(config, logger)
    await client.get('/users/x/mailFolders/inbox/messages')
    await client.get('/users/x/mailFolders/inbox/messages')

    const richiesteToken = chiamate.filter((u) => u.includes('/oauth2/v2.0/token'))
    expect(richiesteToken).toHaveLength(1)
    expect(chiamate[0]).toContain('/tenant-di-prova/oauth2/v2.0/token')
  })

  it('un secret scaduto dice di rigenerarlo, non solo "400"', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => risposta({ error: 'invalid_client', error_description: 'AADSTS7000222: expired' }, 400)),
    )
    const client = new ClientGraph(config, logger)
    await expect(client.accessToken()).rejects.toThrow(/SCADUTO/)
  })
})

describe('messaggi d errore', () => {
  it('403: consenso mancante o ApplicationAccessPolicy', () => {
    expect(messaggioChiaro(403, '{}')).toMatch(/consenso amministratore/)
    expect(messaggioChiaro(403, '{}')).toMatch(/ApplicationAccessPolicy/)
  })

  it('404: indica MS_MAILBOX', () => {
    expect(messaggioChiaro(404, '{}')).toMatch(/MS_MAILBOX/)
  })

  it("secret sbagliato: ricorda che serve il valore, non l'id", () => {
    expect(messaggioToken(401, 'AADSTS7000215: Invalid client secret')).toMatch(/valore/)
  })

  it('app non trovata: indica i due id da controllare', () => {
    expect(messaggioToken(400, 'AADSTS700016: not found')).toMatch(/MS_CLIENT_ID e MS_TENANT_ID/)
  })
})
