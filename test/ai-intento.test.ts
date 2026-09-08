import { describe, it, expect } from 'vitest'
import { interpretaRisposta } from '../src/core/ai/intento.js'

describe('interpretaRisposta', () => {
  it('accetta una singola categoria valida', () => {
    expect(interpretaRisposta('reso')).toEqual(['reso'])
  })

  it('accetta due categorie separate da virgola', () => {
    expect(interpretaRisposta('reso, rimborso')).toEqual(['reso', 'rimborso'])
  })

  it('tollera spazi e maiuscole', () => {
    expect(interpretaRisposta('  Reso ,  RIMBORSO ')).toEqual(['reso', 'rimborso'])
  })

  it('scarta una categoria inventata dal modello e tiene solo quelle valide', () => {
    expect(interpretaRisposta('reso, categoria-inventata')).toEqual(['reso'])
  })

  it('un testo di sole categorie inventate ricade su altro', () => {
    expect(interpretaRisposta('non lo so, boh')).toEqual(['altro'])
  })

  it('una risposta vuota ricade su altro', () => {
    expect(interpretaRisposta('')).toEqual(['altro'])
  })

  it('più di due categorie valide viene troncato a due', () => {
    expect(interpretaRisposta('reso, rimborso, garanzia, fattura')).toEqual(['reso', 'rimborso'])
  })

  it('non duplica la stessa categoria ripetuta', () => {
    expect(interpretaRisposta('reso, reso')).toEqual(['reso'])
  })

  it('accetta categorie separate da a capo, non solo da virgola', () => {
    expect(interpretaRisposta('reso\nrimborso')).toEqual(['reso', 'rimborso'])
  })
})
