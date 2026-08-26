import { describe, it, expect } from 'vitest'
import { redigi } from '../src/core/ai/redazione.js'

describe('redigi — IBAN', () => {
  it('oscura un IBAN italiano', () => {
    const { testo, trovati } = redigi('Il rimborso vada su IT60X0542811101000000123456, grazie')
    expect(testo).not.toContain('IT60')
    expect(testo).toContain('[IBAN oscurato]')
    expect(trovati.iban).toBe(1)
  })
})

describe('redigi — carte di pagamento', () => {
  it('oscura una carta scritta a gruppi di quattro', () => {
    const { testo, trovati } = redigi('La mia carta è 4532 0151 1283 0366')
    expect(testo).toContain('[numero di carta oscurato]')
    expect(testo).not.toContain('0151')
    expect(trovati.carta).toBe(1)
  })

  it('oscura una carta scritta tutta insieme', () => {
    const { testo, trovati } = redigi('Numero carta: 4532015112830366')
    expect(testo).toContain('[numero di carta oscurato]')
    expect(trovati.carta).toBe(1)
  })

  it('NON oscura un numero d\'ordine Amazon, stessa forma cifre-trattini', () => {
    const { testo, trovati } = redigi('Il mio ordine è 407-6403985-4699551, dov\'è il pacco?')
    expect(testo).toContain('407-6403985-4699551')
    expect(trovati.carta).toBe(0)
  })

  it('NON oscura un numero di tracciamento corto', () => {
    const { testo } = redigi('Tracking BRT: 066062028413')
    expect(testo).toContain('066062028413')
  })
})

describe('redigi — codice fiscale', () => {
  it('oscura un codice fiscale italiano', () => {
    const { testo, trovati } = redigi('Il mio codice fiscale è RSSMRA85M01H501Z per la fattura')
    expect(testo).not.toContain('RSSMRA85M01H501Z')
    expect(testo).toContain('[codice fiscale oscurato]')
    expect(trovati.codice_fiscale).toBe(1)
  })
})

describe('redigi — testo pulito', () => {
  it('lascia invariato un messaggio senza dati sensibili', () => {
    const testo = 'Buongiorno, il prodotto è arrivato danneggiato, vorrei un rimborso.'
    const esito = redigi(testo)
    expect(esito.testo).toBe(testo)
    expect(esito.trovati).toEqual({ iban: 0, carta: 0, codice_fiscale: 0 })
  })

  it('oscura più dati diversi nello stesso testo', () => {
    const { testo, trovati } = redigi(
      'IBAN IT60X0542811101000000123456, carta 4532 0151 1283 0366, CF RSSMRA85M01H501Z',
    )
    expect(trovati).toEqual({ iban: 1, carta: 1, codice_fiscale: 1 })
    expect(testo).not.toMatch(/IT60|0151|RSSMRA/)
  })
})
