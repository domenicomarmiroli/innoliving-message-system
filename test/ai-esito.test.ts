import { describe, expect, it } from 'vitest'

import { calcolaEsito } from '../src/core/ai/esito.js'

describe('calcolaEsito', () => {
  it('testo identico → usata_invariata', () => {
    expect(calcolaEsito('Buongiorno, ecco il tracking.', 'Buongiorno, ecco il tracking.')).toBe(
      'usata_invariata',
    )
  })

  it('ignora solo spazi iniziali/finali', () => {
    expect(calcolaEsito('Buongiorno.', '  Buongiorno.  ')).toBe('usata_invariata')
  })

  it('testo corretto dall\'operatore → usata_modificata', () => {
    expect(calcolaEsito('Buongiorno, ecco il tracking.', 'Buongiorno! Ecco il tracking.')).toBe(
      'usata_modificata',
    )
  })

  it('testo completamente riscritto → usata_modificata', () => {
    expect(calcolaEsito('Proposta del modello.', 'Risposta scritta da zero dall\'operatore.')).toBe(
      'usata_modificata',
    )
  })
})
