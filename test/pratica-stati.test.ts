import { describe, it, expect } from 'vitest'

import { componiAvviso, numeroTicketDaPratica, statoDaEsitoMagazzino } from '../src/core/pratica/stati.js'

describe('stato della pratica dai rientri di magazzino', () => {
  it('esito del magazzino → stato', () => {
    expect(statoDaEsitoMagazzino('sostituzione')).toBe('rientrata_sostituzione')
    expect(statoDaEsitoMagazzino('sostituzione_altro_modello')).toBe('rientrata_sostituzione_altro_modello')
    expect(statoDaEsitoMagazzino('funzionante_rinvio')).toBe('rientrata_funzionante')
    expect(statoDaEsitoMagazzino('riparazione')).toBe('rientrata_riparazione')
    expect(statoDaEsitoMagazzino('non_conformita')).toBe('rientrata_non_conforme')
    expect(statoDaEsitoMagazzino('qualcosa_di_nuovo')).toBe('rientrata')
    expect(statoDaEsitoMagazzino(null)).toBe('rientrata')
  })

  it('solo i nostri numeri di ticket, mai quelli del partner', () => {
    expect(numeroTicketDaPratica('12119')).toBe(12119)
    expect(numeroTicketDaPratica('#12119')).toBe(12119)
    expect(numeroTicketDaPratica('TK-12119')).toBe(12119)
    expect(numeroTicketDaPratica('GGF-1499')).toBeNull()
    expect(numeroTicketDaPratica('PA-INT-0000003161')).toBeNull()
    expect(numeroTicketDaPratica(null)).toBeNull()
  })
})

describe('testo degli avvisi', () => {
  const modello = 'Spedito (pratica n. {numero}).\nCorriere: {corriere}\nTracciamento: {tracking}\n{link_tracking}'
  it('riempie i segnaposto', () => {
    const t = componiAvviso(modello, { numero: '12119', corriere: 'BRT', tracking: '066061609726', link_tracking: 'https://x' })
    expect(t).toBe('Spedito (pratica n. 12119).\nCorriere: BRT\nTracciamento: 066061609726\nhttps://x')
  })
  it('toglie le righe con un dato mancante invece di lasciarle vuote', () => {
    const t = componiAvviso(modello, { numero: '12119', tracking: '066061609726' })
    expect(t).toBe('Spedito (pratica n. 12119).\nTracciamento: 066061609726')
  })
})
