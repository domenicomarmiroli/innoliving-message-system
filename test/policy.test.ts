import { describe, it, expect } from 'vitest'
import { check } from '../src/core/policy.js'

describe('policy — amazon', () => {
  it('blocca un link', () => {
    const esito = check('amazon', 'Guarda qui https://esempio.it/pagina per i dettagli')
    expect(esito.ok).toBe(false)
    expect(esito.violazioni.map((v) => v.codice)).toContain('url_non_ammesso')
  })

  it('ammette un link di tracciamento di un corriere', () => {
    const esito = check(
      'amazon',
      'Il tracking è disponibile qui: https://www.poste.it/cerca/index.html#/risultati-spedizioni/1UW1URV142811',
    )
    expect(esito.ok).toBe(true)
    expect(esito.violazioni).toEqual([])
  })

  it('ammette un link ad Amazon stessa (una pagina di aiuto)', () => {
    // Caso reale segnalato da Domenico: un link alle politiche di reso
    // di Amazon veniva bloccato come se portasse il cliente fuori
    // piattaforma — ma è Amazon stessa, non un sito esterno.
    const esito = check(
      'amazon',
      'Trova tutte le informazioni qui: https://www.amazon.it/gp/help/customer/display.html?nodeId=GV38326YW5JX9V9X',
    )
    expect(esito.ok).toBe(true)
    expect(esito.violazioni).toEqual([])
  })

  it('blocca comunque un link che non è né di un corriere né di Amazon, mescolato a uno ammesso', () => {
    const esito = check(
      'amazon',
      'Info qui https://www.amazon.it/gp/help/x e scrivici anche su https://esempio.it/altro',
    )
    expect(esito.ok).toBe(false)
    expect(esito.violazioni).toHaveLength(1)
    expect(esito.violazioni[0]?.porzione).toContain('esempio.it')
  })

  it('blocca comunque un link che non è di un corriere, mescolato a uno di tracciamento', () => {
    const esito = check(
      'amazon',
      'Tracking qui https://www.poste.it/cerca/x e scrivici anche su https://esempio.it/altro',
    )
    expect(esito.ok).toBe(false)
    expect(esito.violazioni).toHaveLength(1)
    expect(esito.violazioni[0]?.porzione).toContain('esempio.it')
  })

  it('blocca un indirizzo email', () => {
    const esito = check('amazon', 'Scrivici a assistenza@esempio.it per aiuto')
    expect(esito.ok).toBe(false)
    expect(esito.violazioni.map((v) => v.codice)).toContain('email_non_ammessa')
  })

  it('segnala un numero di telefono ma non blocca l\'invio (Amazon non lo blocca davvero)', () => {
    const esito = check('amazon', 'Chiamaci al 333 1234567 per assistenza')
    expect(esito.ok).toBe(true)
    const violazione = esito.violazioni.find((v) => v.codice === 'telefono_non_ammesso')
    expect(violazione).toBeDefined()
    expect(violazione?.bloccante).toBe(false)
  })

  it('non scambia un numero d\'ordine Amazon per un telefono', () => {
    const esito = check(
      'amazon',
      'Al momento non risulta un ordine collegato con il numero indicato (405-0668977-2033157).',
    )
    expect(esito.ok).toBe(true)
    expect(esito.violazioni).toEqual([])
  })

  it('segnala comunque un telefono vero anche accanto a un numero d\'ordine Amazon, senza bloccare', () => {
    const esito = check(
      'amazon',
      'Il suo ordine 405-0668977-2033157 è confermato. Ci chiami al 333 1234567 per urgenze.',
    )
    expect(esito.ok).toBe(true)
    const violazione = esito.violazioni.find((v) => v.codice === 'telefono_non_ammesso')
    expect(violazione).toBeDefined()
    expect(violazione?.porzione).not.toContain('405-0668977-2033157')
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
