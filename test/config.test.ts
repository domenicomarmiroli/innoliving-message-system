import { describe, it, expect } from 'vitest'
import { parseConfig } from '../src/config.js'

describe('configurazione', () => {
  it('fallisce e nomina la variabile mancante', () => {
    const r = parseConfig({} as NodeJS.ProcessEnv)
    expect(r.success).toBe(false)
    if (!r.success) {
      const campi = r.error.issues.map((i) => i.path.join('.'))
      expect(campi).toContain('SUPABASE_DB_URL')
    }
  })

  it('accetta la configurazione minima e applica i default', () => {
    const r = parseConfig({ SUPABASE_DB_URL: 'postgresql://x' } as NodeJS.ProcessEnv)
    expect(r.success).toBe(true)
    if (r.success) {
      expect(r.data.PORT).toBe(3000)
      expect(r.data.LOG_LEVEL).toBe('info')
      expect(r.data.NODE_ENV).toBe('development')
    }
  })

  it('rifiuta una porta non numerica', () => {
    const r = parseConfig({ SUPABASE_DB_URL: 'postgresql://x', PORT: 'abc' } as NodeJS.ProcessEnv)
    expect(r.success).toBe(false)
  })
})
