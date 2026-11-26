import { describe, expect, it } from 'vitest'
import { notaResoConsegnato, quandoLeggibile } from '../src/connectors/reso/consegnato.js'
import { ETICHETTA_PRATICA, praticaPerCliente } from '../src/core/clienti/area.js'
import { STATI_PRATICA } from '../src/core/pratica/stati.js'

describe('reso consegnato al magazzino', () => {
  it('nota interna con tipo, giorno e ora italiani', () => {
    const d = new Date('2026-11-25T08:18:00Z')
    expect(quandoLeggibile(d)).toBe('25/11 alle 09:18')
    const nota = notaResoConsegnato('garanzia', d)
    expect(nota).toContain('Reso (garanzia) consegnato da BRT al magazzino il 25/11 alle 09:18')
    expect(nota).toContain('Ticket riaperto')
  })

  it('senza data non inventa niente', () => {
    expect(notaResoConsegnato('recesso', null)).toMatch(/^Reso \(recesso\) consegnato da BRT al magazzino\. /)
  })
})

describe('stato della pratica nell\'area cliente', () => {
  it('ogni stato ha la sua frase per il cliente', () => {
    for (const s of STATI_PRATICA) expect(ETICHETTA_PRATICA[s]).toBeTruthy()
  })

  it('la non conformità per il cliente è una verifica', () => {
    expect(praticaPerCliente('rientrata_non_conforme')).toBe('Prodotto arrivato: in verifica')
    expect(praticaPerCliente('etichetta_inviata')).toBe('Etichetta di reso inviata')
    expect(praticaPerCliente(null)).toBeNull()
  })
})
