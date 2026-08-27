import { describe, it, expect } from 'vitest'
import { normalizzaNumeroOrdine } from '../src/routes/contatti.js'

describe('normalizzaNumeroOrdine', () => {
  it('toglie il cancelletto iniziale', () => {
    expect(normalizzaNumeroOrdine('#1234')).toBe('1234')
  })

  it('lascia invariato un numero senza cancelletto', () => {
    expect(normalizzaNumeroOrdine('1234')).toBe('1234')
  })

  it('toglie gli spazi ai bordi', () => {
    expect(normalizzaNumeroOrdine('  #1234  ')).toBe('1234')
  })
})
