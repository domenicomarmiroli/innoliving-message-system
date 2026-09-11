import { describe, it, expect } from 'vitest'
import { formattaAnnullamento } from '../src/connectors/mail/annullamenti.js'

describe('formattaAnnullamento', () => {
  it('cita il numero ordine e indica che va inoltrata alla logistica', () => {
    const testo = formattaAnnullamento('404-1296441-3120351')
    expect(testo).toContain('404-1296441-3120351')
    expect(testo).toContain('logistica')
    expect(testo.toLowerCase()).toContain('urgente')
  })
})
