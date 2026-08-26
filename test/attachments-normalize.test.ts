import { randomBytes } from 'node:crypto'
import sharp from 'sharp'
import { describe, it, expect } from 'vitest'
import { prepare } from '../src/core/attachments/normalize.js'

// Rumore casuale: comprime male, quindi un JPEG a qualità 100 su
// un'immagine abbastanza grande resta sopra i 6 MB — condizione che il
// test verifica invece di darla per scontata.
async function jpegGrande(): Promise<Buffer> {
  const larghezza = 3600
  const altezza = 2400
  const raw = randomBytes(larghezza * altezza * 3)
  return sharp(raw, { raw: { width: larghezza, height: altezza, channels: 3 } })
    .jpeg({ quality: 100 })
    .toBuffer()
}

describe('normalizzazione allegati — amazon', () => {
  it('converte un JPG grande in PNG sotto i 5 MB', async () => {
    const jpg = await jpegGrande()
    expect(jpg.byteLength).toBeGreaterThan(6 * 1024 * 1024) // precondizione del test

    const esito = await prepare('amazon', {
      nome_file: 'foto.jpg',
      mime: 'image/jpeg',
      contenuto: jpg,
    })

    expect(esito.ok).toBe(true)
    if (esito.ok) {
      expect(esito.mime).toBe('image/png')
      expect(esito.nome_file).toBe('foto.png')
      expect(esito.convertito_da).toBe('image/jpeg')
      expect(esito.contenuto.byteLength).toBeLessThan(5 * 1024 * 1024)
    }
  }, 20_000)

  it('rifiuta uno zip con un motivo leggibile', async () => {
    const esito = await prepare('amazon', {
      nome_file: 'archivio.zip',
      mime: 'application/zip',
      contenuto: Buffer.from('PK finto contenuto zip'),
    })

    expect(esito.ok).toBe(false)
    if (!esito.ok) {
      expect(esito.motivo).toMatch(/non ammesso/i)
    }
  })

  it('rifiuta un HEIC dichiarando il debito, non un errore muto', async () => {
    const esito = await prepare('amazon', {
      nome_file: 'foto.heic',
      mime: 'image/heic',
      contenuto: Buffer.from('finto heic'),
    })

    expect(esito.ok).toBe(false)
    if (!esito.ok) {
      expect(esito.motivo).toMatch(/heic/i)
    }
  })

  it('lascia passare un PDF piccolo senza modifiche', async () => {
    const contenuto = Buffer.from('%PDF-1.4 finto contenuto pdf')
    const esito = await prepare('amazon', {
      nome_file: 'fattura.pdf',
      mime: 'application/pdf',
      contenuto,
    })

    expect(esito.ok).toBe(true)
    if (esito.ok) {
      expect(esito.contenuto).toEqual(contenuto)
      expect(esito.convertito_da).toBeNull()
    }
  })
})

describe('normalizzazione allegati — altri canali', () => {
  it('shopify ed email: nessuna restrizione', async () => {
    const contenuto = Buffer.from('qualunque cosa')
    for (const kind of ['shopify', 'email']) {
      const esito = await prepare(kind, {
        nome_file: 'file.zip',
        mime: 'application/zip',
        contenuto,
      })
      expect(esito.ok).toBe(true)
    }
  })
})
