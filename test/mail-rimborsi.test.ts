import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'

import { analizza } from '../src/connectors/mail/parse.js'
import { estraiDatiRimborso, formattaRimborso } from '../src/connectors/mail/rimborsi.js'

/**
 * Come amazon-richiesta-reso-reale.eml, questa fixture NON è sintetica:
 * è l'email reale di Amazon per il rimborso sull'ordine
 * 405-8567267-4113132 (headers ricostruiti, CSS rimosso).
 */

const eml = (nome: string) => readFileSync(`test/fixtures/mail/${nome}`)

describe('estrazione dei dati di rimborso su un esemplare reale', () => {
  it('legge importo e valuta dalla frase riassuntiva', async () => {
    const email = await analizza(eml('amazon-rimborso-emesso-reale.eml'), 400)
    const dati = estraiDatiRimborso(email.body_html)

    expect(dati.valuta).toBe('EUR')
    expect(dati.importo_totale).toBe(169.01)
  })

  it('legge la rete logistica', async () => {
    const email = await analizza(eml('amazon-rimborso-emesso-reale.eml'), 401)
    const dati = estraiDatiRimborso(email.body_html)
    expect(dati.rete_logistica).toBe('Gestito dal venditore')
  })

  it('legge la riga dell articolo dalla tabella, sette colonne', async () => {
    const email = await analizza(eml('amazon-rimborso-emesso-reale.eml'), 402)
    const dati = estraiDatiRimborso(email.body_html)

    expect(dati.righe).toHaveLength(1)
    expect(dati.righe[0]).toEqual({
      prodotto: 'Macchina Fabbricatore Del Ghiaccio Professionale Innoliving Inn-852 Nero',
      asin: 'B07QJ74726',
      sku: 'INN-852IS',
      quantita: '1',
      rimborso_prezzo: '169',
      rimborso_spedizione: '0',
      motivo: 'Goodwill/Rimborso spese di restituzione',
    })
  })

  it('un html assente non fa esplodere niente', () => {
    const dati = estraiDatiRimborso(null)
    expect(dati.righe).toEqual([])
    expect(dati.importo_totale).toBeNull()
  })

  it('una frase diversa da quella attesa lascia importo/valuta a null, non fallisce', () => {
    const dati = estraiDatiRimborso('<p>nessuna frase di rimborso qui</p>')
    expect(dati.importo_totale).toBeNull()
    expect(dati.valuta).toBeNull()
  })
})

describe('formattazione del riassunto rimborso', () => {
  it('produce un testo leggibile con importo e articolo', async () => {
    const email = await analizza(eml('amazon-rimborso-emesso-reale.eml'), 403)
    const dati = estraiDatiRimborso(email.body_html)
    const testo = formattaRimborso('405-8567267-4113132', dati)

    expect(testo).toContain("Rimborso emesso da Amazon per l'ordine 405-8567267-4113132.")
    expect(testo).toContain('Importo: EUR 169.01')
    expect(testo).toContain('Macchina Fabbricatore Del Ghiaccio Professionale Innoliving Inn-852 Nero')
    expect(testo).toContain('Motivo: Goodwill/Rimborso spese di restituzione')
  })
})
