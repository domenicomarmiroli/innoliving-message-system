import { describe, it, expect } from 'vitest'
import { estraiNumeroOrdineDaRiferimento } from '../src/connectors/magazzino/rientri.js'

describe('estraiNumeroOrdineDaRiferimento', () => {
  it('estrae il numero ordine da un riferimento Zoho con prefisso AMZS', () => {
    expect(estraiNumeroOrdineDaRiferimento('AMZS407-9987997-0665947')).toBe('407-9987997-0665947')
  })

  it('è tollerante a maiuscole/minuscole nel prefisso', () => {
    expect(estraiNumeroOrdineDaRiferimento('amzs403-4432218-2247505')).toBe('403-4432218-2247505')
  })

  it('tollera spazi accidentali intorno al riferimento', () => {
    expect(estraiNumeroOrdineDaRiferimento('  AMZS404-0052699-3816358  ')).toBe('404-0052699-3816358')
  })

  it('restituisce null per riferimenti di altri canali (garanzia, TikTok, ecc.)', () => {
    expect(estraiNumeroOrdineDaRiferimento('PA-INT-0000003651')).toBeNull()
    expect(estraiNumeroOrdineDaRiferimento('A-SOS2068')).toBeNull()
    expect(estraiNumeroOrdineDaRiferimento('TTOK6385')).toBeNull()
    expect(estraiNumeroOrdineDaRiferimento('BB920403726-F1')).toBeNull()
  })

  it('restituisce null per un riferimento assente', () => {
    expect(estraiNumeroOrdineDaRiferimento(null)).toBeNull()
  })

  it('restituisce null se il numero dopo il prefisso non ha la forma di un ordine Amazon', () => {
    expect(estraiNumeroOrdineDaRiferimento('AMZS12345')).toBeNull()
  })
})
