import { describe, it, expect } from 'vitest'

import { costruisciMessageInput } from '../src/connectors/mirakl/invia.js'

/**
 * Regressione sul primo invio reale (Leroy Merlin France, 28/08): Mirakl
 * rifiutava con "Required part 'message_input' is not present" perché il
 * codice mandava i campi appiattiti (message_input.body,
 * message_input.to[0].type) invece di un'unica parte multipart chiamata
 * "message_input" col JSON intero. Qui testiamo solo la forma del JSON,
 * non il wire format multipart — quello lo verifica il prossimo invio
 * reale.
 */
describe('costruisciMessageInput', () => {
  it('produce un solo oggetto con body e to, non campi appiattiti', () => {
    expect(costruisciMessageInput('Grazie, procediamo', ['CUSTOMER'])).toEqual({
      body: 'Grazie, procediamo',
      to: [{ type: 'CUSTOMER' }],
    })
  })

  it('supporta più destinatari nello stesso invio', () => {
    expect(costruisciMessageInput('Testo', ['CUSTOMER', 'OPERATOR'])).toEqual({
      body: 'Testo',
      to: [{ type: 'CUSTOMER' }, { type: 'OPERATOR' }],
    })
  })
})
