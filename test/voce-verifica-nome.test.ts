import { describe, it, expect } from 'vitest'

import { nomeCorrisponde } from '../src/core/voce/verifica.js'

describe('richiamata: il nome di chi risponde', () => {
  const archivio = ['Mario Rossi', 'Giulia Bianchi']

  it('nome e cognome, in qualunque ordine, senza accenti né maiuscole', () => {
    expect(nomeCorrisponde('Mario Rossi', archivio)).toBe(true)
    expect(nomeCorrisponde('rossi mario', archivio)).toBe(true)
    expect(nomeCorrisponde('Sono Giulia Bianchi', archivio)).toBe(true)
    expect(nomeCorrisponde('Nicolò Ferrà', ['Nicolo Ferra'])).toBe(true)
  })

  it('tollera una lettera sbagliata dalla trascrizione sulle parole lunghe', () => {
    expect(nomeCorrisponde('Mario Rosssi', archivio)).toBe(true)
    expect(nomeCorrisponde('Giulia Bianci', archivio)).toBe(true)
  })

  it('il solo nome di battesimo non basta', () => {
    expect(nomeCorrisponde('Mario', archivio)).toBe(false)
    expect(nomeCorrisponde('Luca', ['Marco De Luca'])).toBe(false)
  })

  it('un altro nome non corrisponde', () => {
    expect(nomeCorrisponde('Paolo Verdi', archivio)).toBe(false)
    expect(nomeCorrisponde('Maria Rossa', ['Mario Rossi'])).toBe(false)
    expect(nomeCorrisponde('', archivio)).toBe(false)
  })

  it('se in archivio c’è una parola sola, basta quella', () => {
    expect(nomeCorrisponde('Signor Rossi', ['Rossi'])).toBe(true)
  })
})
