import { describe, it, expect } from 'vitest'
import { dimensioniImmagine } from '../src/core/immagine.js'

// PNG 2x1 pixel, valido, generato una volta e incollato qui: non serve
// un file esterno per due pixel.
const PNG_2X1 = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAIAAAABCAYAAAD0YtCiAAAAEUlEQVR42mNk+M9QDwABgQF/E1RJPQAAAABJRU5ErkJggg==',
  'base64',
)

describe('dimensioniImmagine', () => {
  it('legge larghezza e altezza da un PNG valido', async () => {
    const dim = await dimensioniImmagine(PNG_2X1)
    expect(dim).toEqual({ larghezza: 2, altezza: 1 })
  })

  it('torna null su byte che non sono un\'immagine', async () => {
    const dim = await dimensioniImmagine(Buffer.from('non è un\'immagine'))
    expect(dim).toBeNull()
  })

  it('torna null su buffer vuoto', async () => {
    const dim = await dimensioniImmagine(Buffer.alloc(0))
    expect(dim).toBeNull()
  })
})
