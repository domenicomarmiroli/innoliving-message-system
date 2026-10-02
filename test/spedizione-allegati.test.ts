import { describe, it, expect } from 'vitest'
import sharp from 'sharp'
import { randomBytes } from 'node:crypto'
import type { FilePronto } from '../src/core/attachments/normalize.js'
import { adattaAllegatiAlTrasporto } from '../src/connectors/mail/spedizione.js'

/**
 * Le foto inoltrate al corriere dalla casella Microsoft: Graph accetta
 * circa 2 MB di allegati per email, quattro foto da telefono ne pesano
 * dieci. Il rumore casuale serve a non avere immagini che si comprimono
 * da sole come una tinta unita: è il caso peggiore, più pesante di una
 * foto vera.
 */
async function fotoPesante(nome: string, lato = 1800): Promise<FilePronto> {
  const contenuto = await sharp(randomBytes(lato * lato * 3), {
    raw: { width: lato, height: lato, channels: 3 },
  })
    .jpeg({ quality: 95 })
    .toBuffer()
  return { nome_file: nome, mime: 'image/jpeg', contenuto, convertito_da: null, note: [] }
}

const totale = (a: FilePronto[]) => a.reduce((n, x) => n + x.contenuto.byteLength, 0)
const BUDGET_APPROSSIMATO = 2 * 1024 * 1024

describe('adattaAllegatiAlTrasporto', () => {
  it('su Gmail non tocca niente, anche se pesante', async () => {
    const foto = [await fotoPesante('a.jpg'), await fotoPesante('b.jpg')]
    const esito = await adattaAllegatiAlTrasporto('imap', foto)
    expect(esito).toBe(foto)
  }, 30_000)

  it('su Microsoft non tocca allegati che già ci stanno', async () => {
    const piccolo: FilePronto = {
      nome_file: 'ricevuta.pdf',
      mime: 'application/pdf',
      contenuto: Buffer.alloc(50_000),
      convertito_da: null,
      note: [],
    }
    const esito = await adattaAllegatiAlTrasporto('graph', [piccolo])
    expect(esito).toEqual([piccolo])
  })

  it('su Microsoft riduce le foto finché il totale rientra, e lo dichiara', async () => {
    const foto = [
      await fotoPesante('IMG_1.jpeg'),
      await fotoPesante('IMG_2.jpeg'),
      await fotoPesante('IMG_3.png'),
    ]
    foto[2] = { ...foto[2]!, mime: 'image/png' }
    expect(totale(foto)).toBeGreaterThan(BUDGET_APPROSSIMATO)

    const esito = await adattaAllegatiAlTrasporto('graph', foto)

    expect(totale(esito)).toBeLessThan(BUDGET_APPROSSIMATO)
    expect(esito).toHaveLength(3)
    for (const a of esito.filter((x) => x.note.length > 0)) {
      expect(a.mime).toBe('image/jpeg')
      expect(a.nome_file).toMatch(/\.jpg$/)
      expect(a.convertito_da).not.toBeNull()
      expect(a.note.join(' ')).toMatch(/Microsoft/)
    }
  }, 60_000)

  it('un PDF troppo grande non si può ridurre: errore leggibile, non un 413 di Microsoft', async () => {
    const pdf: FilePronto = {
      nome_file: 'manuale.pdf',
      mime: 'application/pdf',
      contenuto: Buffer.alloc(5 * 1024 * 1024),
      convertito_da: null,
      note: [],
    }
    await expect(adattaAllegatiAlTrasporto('graph', [pdf])).rejects.toThrow(/togline qualcuno/)
  })
})
