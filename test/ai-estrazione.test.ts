import { describe, it, expect } from 'vitest'
import { estraiTesto } from '../src/core/ai/estrazione.js'
import { creaProvider } from '../src/core/ai/provider.js'

describe('estraiTesto', () => {
  it('legge un file di testo semplice', async () => {
    const testo = await estraiTesto(Buffer.from('Politica resi: 30 giorni.'), 'text/plain', 'note.txt')
    expect(testo).toBe('Politica resi: 30 giorni.')
  })

  it('legge un markdown come testo semplice', async () => {
    const testo = await estraiTesto(Buffer.from('# Titolo\ncontenuto'), 'text/markdown', 'guida.md')
    expect(testo).toContain('Titolo')
  })

  it('rifiuta un formato non supportato', async () => {
    await expect(estraiTesto(Buffer.from('x'), 'application/zip', 'archivio.zip')).rejects.toThrow(
      /non supportato/,
    )
  })

  it('rifiuta un file di testo vuoto', async () => {
    await expect(estraiTesto(Buffer.alloc(0), 'text/plain', 'vuoto.txt')).rejects.toThrow(/vuoto/)
  })
})

describe('creaProvider', () => {
  it('rifiuta senza ANTHROPIC_API_KEY', async () => {
    await expect(
      creaProvider({ AI_PROVIDER: 'anthropic', ANTHROPIC_MODEL: 'claude-sonnet-5' }),
    ).rejects.toThrow(/ANTHROPIC_API_KEY/)
  })

  it('crea il provider Anthropic quando la chiave c\'è', async () => {
    const provider = await creaProvider({
      AI_PROVIDER: 'anthropic',
      ANTHROPIC_API_KEY: 'chiave-di-prova',
      ANTHROPIC_MODEL: 'claude-sonnet-5',
    })
    expect(provider.nome).toBe('anthropic')
  })
})
