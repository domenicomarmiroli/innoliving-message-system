import { describe, it, expect } from 'vitest'
import {
  chiaveCollegamento,
  chiaveValida,
  emailRegistrazioneGaranzia,
  linkPortale,
  testoRegistrazione,
} from '../src/core/garanzia/collegamento.js'

const segreto = 'segreto-di-prova-abbastanza-lungo'
const id = '9a6bfe34-33ec-4c4d-a257-9bc3f5d9ed38'

describe('collegamento garanzia', () => {
  it('la chiave del link apre solo quel ticket', () => {
    const k = chiaveCollegamento(id, segreto)
    expect(chiaveValida(id, k, segreto)).toBe(true)
    expect(chiaveValida('00000000-0000-0000-0000-000000000000', k, segreto)).toBe(false)
    expect(chiaveValida(id, k, 'altro-segreto-lungo-abbastanza')).toBe(false)
    expect(chiaveValida(id, null, segreto)).toBe(false)
  })
  it('link al portale con richiesta e chiave, anche se il portale ha già parametri', () => {
    const l = linkPortale('https://garanzia.esempio.it/registra?brand=x', id, 'abc')
    expect(l).toBe(`https://garanzia.esempio.it/registra?brand=x&richiesta=${id}&chiave=abc`)
  })
  it("l'email dice cosa fare in tre passi, con il numero e il link", () => {
    const e = emailRegistrazioneGaranzia({ numero: '12345', nome: 'Mario', marchio: 'Innoliving', prodotto: 'Friggitrice', link: 'https://x/y' })
    expect(e.oggetto).toContain('12345')
    expect(e.testo).toContain('Gentile Mario,')
    expect(e.testo).toContain('1. Apra questo link: https://x/y')
    expect(e.testo).toContain('non deve riscrivere nulla')
  })
  it('il messaggio nel ticket elenca solo i dati presenti', () => {
    expect(testoRegistrazione({ prodotto: 'Friggitrice INN-798', data_acquisto: '12/03/2026', codice: '' })).toBe(
      'Prodotto registrato sul portale garanzie.\n\nProdotto: Friggitrice INN-798\nData di acquisto: 12/03/2026',
    )
  })
})
