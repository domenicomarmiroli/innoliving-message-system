import { describe, it, expect } from 'vitest'
import { validaAllegati, MASSIMO_BYTE_FILE } from '../src/connectors/clienti/allegati.js'

const b64 = (n: number) => Buffer.alloc(n, 1).toString('base64')

describe('validaAllegati', () => {
  it('accetta foto e PDF, deducendo il tipo dal nome se manca', () => {
    const f = validaAllegati([
      { nome_file: 'pacco.jpg', contenuto_base64: b64(100) },
      { nome_file: 'scontrino.pdf', mime: 'application/pdf', contenuto_base64: b64(100) },
    ])
    expect(f.map((x) => x.mime)).toEqual(['image/jpeg', 'application/pdf'])
    expect(f[0]!.contenuto.byteLength).toBe(100)
  })
  it('rifiuta tipi non ammessi, file troppo grandi e troppi file, con un messaggio leggibile', () => {
    expect(() => validaAllegati([{ nome_file: 'virus.exe', contenuto_base64: b64(10) }])).toThrow(/tipo accettato/)
    expect(() => validaAllegati([{ nome_file: 'grande.png', contenuto_base64: b64(MASSIMO_BYTE_FILE + 1) }])).toThrow(/supera/)
    expect(() => validaAllegati(Array.from({ length: 6 }, (_, i) => ({ nome_file: `${i}.png`, contenuto_base64: b64(10) })))).toThrow(/al massimo/)
  })
  it('un nome con percorso non esce dalla cartella dello Storage', () => {
    const [f] = validaAllegati([{ nome_file: '../../altro/foto.png', contenuto_base64: b64(10) }])
    expect(f!.nome_file).not.toContain('/')
  })
})
