import { describe, it, expect } from 'vitest'
import { entroFinestraApertura, testoRientroSenzaContatto } from '../src/connectors/magazzino/rientri.js'

describe('rientro senza conversazione', () => {
  const oggi = new Date('2026-10-06T15:30:00Z')
  it('apre ticket solo per rientri recenti, non per lo storico di 60 giorni', () => {
    expect(entroFinestraApertura('2026-10-06T13:23:07Z', oggi)).toBe(true)
    expect(entroFinestraApertura('2026-09-30T10:00:00Z', oggi)).toBe(true)
    expect(entroFinestraApertura('2026-09-01T10:00:00Z', oggi)).toBe(false)
    expect(entroFinestraApertura('non è una data', oggi)).toBe(false)
  })
  it('la nota dice cosa fare: verificare il motivo ed emettere il rimborso', () => {
    const t = testoRientroSenzaContatto('403-4850751-8618728', '025140000028318226')
    expect(t).toContain('403-4850751-8618728')
    expect(t).toContain('025140000028318226')
    expect(t).toMatch(/rimborso/)
  })
})
