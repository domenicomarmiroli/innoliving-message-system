import { describe, it, expect } from 'vitest'
import { check } from '../src/core/policy.js'

describe('policy — amazon', () => {
  it('blocca un link', () => {
    const esito = check('amazon', 'Guarda qui https://esempio.it/pagina per i dettagli')
    expect(esito.ok).toBe(false)
    expect(esito.violazioni.map((v) => v.codice)).toContain('url_non_ammesso')
  })

  it('blocca un indirizzo email', () => {
    const esito = check('amazon', 'Scrivici a assistenza@esempio.it per aiuto')
    expect(esito.ok).toBe(false)
    expect(esito.violazioni.map((v) => v.codice)).toContain('email_non_ammessa')
  })

  it('blocca un numero di telefono', () => {
    const esito = check('amazon', 'Chiamaci al 333 1234567 per assistenza')
    expect(esito.ok).toBe(false)
    expect(esito.violazioni.map((v) => v.codice)).toContain('telefono_non_ammesso')
  })

  it('blocca una richiesta di recensione, in più lingue', () => {
    expect(check('amazon', 'La preghiamo di lasciare una recensione positiva').ok).toBe(false)
    expect(check('amazon', 'Please leave a review if you are happy').ok).toBe(false)
    expect(check('amazon', 'Bitte eine positive Bewertung hinterlassen').ok).toBe(false)
  })

  it('blocca un invito a contattare fuori piattaforma', () => {
    const esito = check('amazon', 'Scrivici su WhatsApp per una risposta più rapida')
    expect(esito.ok).toBe(false)
    expect(esito.violazioni.map((v) => v.codice)).toContain('contatto_esterno')
  })

  it('lascia passare un messaggio pulito', () => {
    const esito = check('amazon', 'Il suo prodotto risulta in garanzia fino al 12 agosto 2028.')
    expect(esito.ok).toBe(true)
    expect(esito.violazioni).toEqual([])
  })
})

describe('policy — mirakl', () => {
  it('blocca un contatto diretto ma ammette un link', () => {
    const conLink = check('mirakl', 'Trova il manuale qui: https://esempio.it/manuale')
    expect(conLink.ok).toBe(true)

    const conEmail = check('mirakl', 'Scrivici a assistenza@esempio.it')
    expect(conEmail.ok).toBe(false)
  })
})

describe('policy — shopify ed email', () => {
  it('nessuna restrizione', () => {
    const testo = 'Contattaci pure a assistenza@esempio.it o su https://esempio.it, grazie per la recensione!'
    expect(check('shopify', testo).ok).toBe(true)
    expect(check('email', testo).ok).toBe(true)
  })
})
