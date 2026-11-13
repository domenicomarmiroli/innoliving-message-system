import { describe, it, expect } from 'vitest'
import { NOMI_COLLEGAMENTO, riassumiErrore, segnalaStato } from '../src/connectors/stato/collegamenti.js'

describe('stato dei collegamenti', () => {
  it("riassume l'errore su una riga, corto, per il banner", () => {
    expect(riassumiErrore(new Error('Graph:  richiesta\n fallita (503)'))).toBe('Graph: richiesta fallita (503)')
    expect(riassumiErrore('x'.repeat(500))).toHaveLength(300)
  })

  it('senza database impostato non fa niente e non lancia', async () => {
    await expect(segnalaStato('invio-microsoft', new Error('giù'))).resolves.toBeUndefined()
  })

  it('ogni collegamento ha un nome leggibile', () => {
    expect(Object.values(NOMI_COLLEGAMENTO).every((n) => n.length > 0)).toBe(true)
  })
})
