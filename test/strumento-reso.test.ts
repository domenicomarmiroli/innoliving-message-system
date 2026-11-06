import { describe, expect, it } from 'vitest'
import Fastify from 'fastify'

import { compilaModello, nomePerSaluto } from '../src/connectors/reso/testo.js'
import { strumentoResoRoutes } from '../src/routes/strumento-reso.js'
import type { Config } from '../src/config.js'

describe('testo del messaggio di reso', () => {
  it('compila nome e numero ordine, lascia intatti gli altri segnaposto', () => {
    const t = compilaModello('Buongiorno {{cliente.nome}}, ordine {{ordine.numero}} {{altro}}', { nome_cliente: 'Mario Rossi', numero_ordine: '404-1' })
    expect(t).toBe('Buongiorno Mario Rossi, ordine 404-1 {{altro}}')
  })
  it('nomi tutti maiuscoli (Amazon) diventano normali; gli altri non si toccano', () => {
    expect(nomePerSaluto("MARIO D'ANGELO")).toBe("Mario D'Angelo")
    expect(nomePerSaluto('Anna De Luca')).toBe('Anna De Luca')
  })
})

describe('schermata /strumenti/reso', () => {
  it('serve la pagina con URL e chiave anonima, senza segreti, e non si indicizza', async () => {
    const app = Fastify()
    await app.register(strumentoResoRoutes, {
      config: { SUPABASE_URL: 'https://x.supabase.co', SUPABASE_ANON_KEY: 'anon', SUPABASE_SERVICE_ROLE_KEY: 'segreto', WORKER_API_TOKEN: 'segreto2' } as unknown as Config,
    })
    const r = await app.inject({ method: 'GET', url: '/strumenti/reso' })
    expect(r.statusCode).toBe(200)
    expect(r.headers['content-type']).toContain('text/html')
    expect(r.headers['x-robots-tag']).toBe('noindex')
    expect(r.body).toContain('https://x.supabase.co')
    expect(r.body).not.toContain('segreto')
    await app.close()
  })
  it('senza Supabase configurato la rotta non esiste', async () => {
    const app = Fastify()
    await app.register(strumentoResoRoutes, { config: {} as unknown as Config })
    expect((await app.inject({ method: 'GET', url: '/strumenti/reso' })).statusCode).toBe(404)
    await app.close()
  })
})
