import { describe, expect, it } from 'vitest'
import {
  daGaranzia, daTesto, dataItaliana, leggiConfigPartner, oggettoPartner, testoPartner, unisci,
} from '../src/core/assistenza-partner.js'

const config = leggiConfigPartner({ email: 'ticket@partner.example', nome: 'Centro prova' })

describe('richiesta al centro assistenza', () => {
  it('dal portale: tutti i dati nelle righe fisse', () => {
    const d = unisci(
      daGaranzia({
        intestatario: 'Mario Rossi', telefono: '333 1234567', brand: 'Marca', prodotto: 'Bollitore',
        codice_modello: 'inn-133', data_acquisto: '2026-06-15', scadenza: '2028-06-15', copertura_mesi: 24,
        valore_prodotto: 23.9, problema: 'Perde acqua dal fondo', numero_ordine: 'SC-77',
        indirizzo_spedizione: { nome: 'Mario', cognome: 'Rossi', indirizzo: 'Via Roma 1', cap: '20100', citta: 'Milano', provincia: 'mi', paese: 'IT' },
      }),
      { numero_ticket: '18991', email: 'mario@example.com' },
    )
    expect(oggettoPartner(config, d)).toBe('RICHIESTA PORTALE GARANZIA Mario Rossi')
    const t = testoPartner(d, null, 1)
    expect(t).toContain('Riferimento nostro ticket: #18991')
    expect(t).toContain('Codice prodotto: INN-133')
    expect(t).toContain('Data di acquisto: 15/06/2026')
    expect(t).toContain('Scadenza garanzia: 15/06/2028')
    expect(t).toContain('Valore pagato (IVA inclusa): 23,90 EUR')
    expect(t).toContain('Indirizzo: Via Roma 1')
    expect(t).toContain('Provincia: MI')
    expect(t).toContain('Numero scontrino/fattura: SC-77')
    expect(t).toContain('Descrizione del problema:\nPerde acqua dal fondo')
    expect(t).toContain('In allegato 1 file')
  })

  it('ticket vecchio: legge le righe del testo, il problema è quello che sta sopra', () => {
    const d = unisci(daTesto(
      "Quando si versa l'acqua, perde dal fondo\n\nProdotto: BOLLITORE\nCodice: inn-732\nData di acquisto: 15/06/2026\nGaranzia valida fino al: 15/06/2028\nTelefono: 3470000000",
    ), { nome: 'Cliente Prova' })
    expect(d.problema).toBe("Quando si versa l'acqua, perde dal fondo")
    expect(d.codice).toBe('INN-732')
    expect(d.scadenza_garanzia).toBe('15/06/2028')
    expect(d.telefono).toBe('3470000000')
  })

  it('le righe ci sono sempre, anche vuote, nello stesso ordine', () => {
    const vuoto = testoPartner(unisci(), null)
    const pieno = testoPartner(unisci({ nome: 'A', problema: 'x' }), 'nota')
    const etichette = (s: string) => s.split('\n').map((r) => r.split(':')[0]).filter((r) => r && r === r.trim())
    expect(vuoto).toContain('Nome e cognome:')
    expect(vuoto).toContain('Numero scontrino/fattura:')
    expect(etichette(pieno).filter((e) => e !== 'x' && e !== 'nota')).toEqual(etichette(vuoto))
    expect(vuoto).not.toContain('In allegato')
  })

  it('date e config', () => {
    expect(dataItaliana('2026-01-05')).toBe('05/01/2026')
    expect(dataItaliana('05/01/2026')).toBe('05/01/2026')
    expect(leggiConfigPartner(null).email).toBeNull()
  })
})
