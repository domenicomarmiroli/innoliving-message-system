import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'

import { analizza } from '../src/connectors/mail/parse.js'
import { estraiDatiReclamo, formattaReclamo } from '../src/connectors/mail/reclami.js'

/**
 * Come le altre fixture "reale", non è sintetica: è l'email vera di
 * Amazon per il reclamo A-to-Z sull'ordine 402-3427577-1965903 (headers
 * ricostruiti, CSS rimosso).
 */

const eml = (nome: string) => readFileSync(`test/fixtures/mail/${nome}`)

describe('estrazione dei dati di reclamo A-to-Z su un esemplare reale', () => {
  it('legge l importo in formato italiano (virgola decimale, non punto)', async () => {
    const email = await analizza(eml('amazon-reclamo-az-reale.eml'), 500)
    const dati = estraiDatiReclamo(email.body_html)
    expect(dati.importo).toBe(119)
  })

  it('legge il termine di risposta in giorni', async () => {
    const email = await analizza(eml('amazon-reclamo-az-reale.eml'), 501)
    const dati = estraiDatiReclamo(email.body_html)
    expect(dati.scadenza_risposta_giorni).toBe(3)
  })

  it('un html assente non fa esplodere niente', () => {
    const dati = estraiDatiReclamo(null)
    expect(dati.importo).toBeNull()
    expect(dati.scadenza_risposta_giorni).toBeNull()
  })

  it('un testo senza la frase attesa lascia i campi a null, non fallisce', () => {
    const dati = estraiDatiReclamo('<p>nessun reclamo qui</p>')
    expect(dati.importo).toBeNull()
    expect(dati.scadenza_risposta_giorni).toBeNull()
  })

  it('non confonde il formato italiano con quello americano dei rimborsi', () => {
    // "1.234,56" italiano deve leggersi 1234.56, non 1.234 (troncato al punto).
    const dati = estraiDatiReclamo('<p>reclamo dalla A alla Z di 1.234,56 EUR</p>')
    expect(dati.importo).toBe(1234.56)
  })
})

describe('formattazione del riassunto reclamo', () => {
  it('produce un testo leggibile con importo e termine di risposta', async () => {
    const email = await analizza(eml('amazon-reclamo-az-reale.eml'), 502)
    const dati = estraiDatiReclamo(email.body_html)
    const testo = formattaReclamo('402-3427577-1965903', dati)

    expect(testo).toContain(
      "Reclamo di Garanzia dalla A alla Z ricevuto da Amazon per l'ordine 402-3427577-1965903.",
    )
    expect(testo).toContain('Importo: EUR 119')
    expect(testo).toContain('Termine per rispondere: 3 giorni di calendario.')
  })
})
