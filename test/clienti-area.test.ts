import { describe, it, expect } from 'vitest'
import { statoPerCliente, testoPerCliente, normalizzaEmail } from '../src/core/clienti/area.js'

describe('area cliente', () => {
  it('gli stati interni diventano pochi stati comprensibili', () => {
    expect(statoPerCliente('new')).toBe('ricevuto')
    expect(statoPerCliente('open')).toBe('in_lavorazione')
    expect(statoPerCliente('pending_internal')).toBe('in_lavorazione')
    expect(statoPerCliente('pending_customer')).toBe('attende_risposta')
    expect(statoPerCliente('closed')).toBe('chiuso')
  })
  it('dal riepilogo telefonico spariscono le righe di servizio per l\u2019operatore', () => {
    const t = 'Non mi è arrivato il pacco.\n\nProdotto: Termoconvettore\nContatto per la risposta: a@b.it\nNumero da cui ha chiamato: +39...\nCliente verificato sull\u2019ordine.'
    expect(testoPerCliente(t, 'telefono', 'customer')).toBe('Non mi è arrivato il pacco.\n\nProdotto: Termoconvettore')
    expect(testoPerCliente('Cliente verificato', 'email', 'customer')).toBe('Cliente verificato')
  })
  it('email confrontata senza maiuscole né spazi', () => {
    expect(normalizzaEmail('  Mario.Rossi@Gmail.COM ')).toBe('mario.rossi@gmail.com')
  })
})
