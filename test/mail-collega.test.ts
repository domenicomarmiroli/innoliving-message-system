import { describe, it, expect } from 'vitest'
import { costruisciOggetto, tagCollegato } from '../src/connectors/mail/collega.js'

describe('costruisciOggetto', () => {
  it('usa l\'oggetto scelto dall\'agente quando presente', () => {
    expect(costruisciOggetto('corriere', 'Pacco fermo in transito', null)).toBe(
      'Pacco fermo in transito',
    )
  })

  it('ignora un oggetto vuoto o di soli spazi e ricade sul default', () => {
    expect(costruisciOggetto('corriere', '   ', null)).toBe('Corriere')
  })

  it('include il riferimento ordine quando non c\'è un oggetto scelto', () => {
    expect(costruisciOggetto('corriere', null, '#1234')).toBe('Corriere — ordine #1234')
  })

  it('usa la sola etichetta quando manca sia oggetto che ordine', () => {
    expect(costruisciOggetto('assistenza', undefined, null)).toBe('Assistenza')
  })

  it('ha un\'etichetta anche per il tipo generico', () => {
    expect(costruisciOggetto('altro', undefined, null)).toBe('Contatto esterno')
  })
})

describe('tagCollegato', () => {
  it('include sempre il tag generico e quello specifico per tipo', () => {
    expect(tagCollegato('corriere')).toEqual(['ticket-collegato', 'collegato-corriere'])
    expect(tagCollegato('assistenza')).toEqual(['ticket-collegato', 'collegato-assistenza'])
    expect(tagCollegato('altro')).toEqual(['ticket-collegato', 'collegato-altro'])
  })
})
