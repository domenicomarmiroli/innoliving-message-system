import { describe, it, expect } from 'vitest'
import { costruisciOggettoImportante, formattaOptOut } from '../src/connectors/mail/optout.js'

describe('costruisciOggettoImportante', () => {
  it('antepone [Importante] a un oggetto normale', () => {
    expect(costruisciOggettoImportante('Re: informazioni sul tuo ordine')).toBe(
      '[Importante] Re: informazioni sul tuo ordine',
    )
  })

  it('non duplica [Importante] se già presente', () => {
    expect(costruisciOggettoImportante('[Importante] Re: informazioni')).toBe(
      '[Importante] Re: informazioni',
    )
  })

  it('è tollerante a maiuscole/minuscole nel prefisso già presente', () => {
    expect(costruisciOggettoImportante('[importante] domanda')).toBe('[importante] domanda')
  })

  it('produce comunque un oggetto quando quello originale è vuoto o assente', () => {
    expect(costruisciOggettoImportante(null)).toBe('[Importante]')
    expect(costruisciOggettoImportante('   ')).toBe('[Importante]')
  })
})

describe('formattaOptOut', () => {
  it('descrive il reinvio riuscito con il numero ordine', () => {
    const testo = formattaOptOut('406-5322013-9383523', 'reinviato')
    expect(testo).toContain('406-5322013-9383523')
    expect(testo).toContain('[Importante]')
  })

  it('descrive la necessità di un intervento manuale', () => {
    const testo = formattaOptOut('406-5322013-9383523', 'richiede_azione_manuale')
    expect(testo).toContain('406-5322013-9383523')
    expect(testo).toContain('Seller Central')
  })
})
