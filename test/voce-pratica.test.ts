import { describe, it, expect } from 'vitest'

import { fasePratica, giorniLavorativiTra, numeroPratica, praticaFerma } from '../src/core/voce/pratica.js'

describe('stato della pratica al telefono', () => {
  it('la fase viene dai tag prima che dallo stato', () => {
    expect(fasePratica('pending_customer', ['attesa-registrazione-garanzia'])).toBe('attende_registrazione_garanzia')
    expect(fasePratica('open', ['garanzia', 'pacco-rientrato-logistica'])).toBe('prodotto_rientrato')
    expect(fasePratica('open', ['garanzia-registrata'])).toBe('garanzia_registrata')
    expect(fasePratica('closed', ['pacco-rientrato-logistica'])).toBe('chiusa')
    expect(fasePratica('open', [])).toBe('in_lavorazione')
  })

  it('giorni lavorativi: il fine settimana non conta', () => {
    // venerdì 2 → lunedì 5 ottobre 2026: un giorno lavorativo
    expect(giorniLavorativiTra(new Date('2026-10-02T10:00Z'), new Date('2026-10-05T10:00Z'))).toBe(1)
    expect(giorniLavorativiTra(new Date('2026-10-05T10:00Z'), new Date('2026-10-19T10:00Z'))).toBe(10)
  })

  it('ferma dopo 10 giorni lavorativi, ma non se aspettiamo il cliente', () => {
    const ora = new Date('2026-10-20T10:00Z')
    expect(praticaFerma('in_lavorazione', new Date('2026-10-05T10:00Z'), ora)).toBe(true)
    expect(praticaFerma('in_lavorazione', new Date('2026-10-12T10:00Z'), ora)).toBe(false)
    expect(praticaFerma('attende_cliente', new Date('2026-09-01T10:00Z'), ora)).toBe(false)
  })

  it('numero di pratica dettato', () => {
    expect(numeroPratica('1 2 1 1 9')).toBe(12119)
    expect(numeroPratica('#12119')).toBe(12119)
    expect(numeroPratica('ciao')).toBeNull()
  })
})
