import { describe, it, expect } from 'vitest'
import { createHmac } from 'node:crypto'

import { verificaFirma } from '../src/connectors/shopify/hmac.js'

const SEGRETO = 'segreto-di-prova'
const corpo = Buffer.from(JSON.stringify({ id: 1, name: 'INSH0001' }))
const firmaValida = createHmac('sha256', SEGRETO).update(corpo).digest('base64')

describe('firma dei webhook Shopify', () => {
  it('accetta una firma valida', () => {
    expect(verificaFirma(corpo, firmaValida, SEGRETO)).toBe(true)
  })

  it('rifiuta una firma calcolata con un altro segreto', () => {
    const altra = createHmac('sha256', 'altro-segreto').update(corpo).digest('base64')
    expect(verificaFirma(corpo, altra, SEGRETO)).toBe(false)
  })

  it('rifiuta se il corpo è stato alterato di un solo byte', () => {
    const alterato = Buffer.from(JSON.stringify({ id: 2, name: 'INSH0001' }))
    expect(verificaFirma(alterato, firmaValida, SEGRETO)).toBe(false)
  })

  it('rifiuta una firma assente', () => {
    expect(verificaFirma(corpo, undefined, SEGRETO)).toBe(false)
  })

  it('rifiuta una firma di lunghezza sbagliata senza lanciare', () => {
    expect(verificaFirma(corpo, 'YWJj', SEGRETO)).toBe(false)
  })
})
