import { describe, it, expect } from 'vitest'
import { normalizzaNumeroOrdine, schemaGaranzia } from '../src/routes/contatti.js'

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

describe('dati della garanzia dal portale', () => {
  it('accetta la scheda completa del portale', () => {
    const r = schemaGaranzia.safeParse({
      certificato: 'CG-ES57XR-C1WN07-F6BA2B-4ECK77-NW',
      brand: 'Innoliving',
      prodotto: 'Ferro Da Stiro Generatore Di Vapore A Carica Continua',
      codice_modello: 'INN-681',
      canale_acquisto: 'Amazon',
      negozio: 'Amazon.it',
      numero_ordine: '402-3710774-5547534',
      data_acquisto: '2026-08-22',
      scadenza: '2029-08-22',
      copertura_mesi: 36,
      estensione: null,
      telefono: '3330000000',
    })
    expect(r.success).toBe(true)
  })

  it('tutto facoltativo: un oggetto vuoto va bene', () => {
    expect(schemaGaranzia.safeParse({}).success).toBe(true)
  })

  it('le date vanno in formato AAAA-MM-GG', () => {
    expect(schemaGaranzia.safeParse({ data_acquisto: '22/08/2026' }).success).toBe(false)
  })
})
