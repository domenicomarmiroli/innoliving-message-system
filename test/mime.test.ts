import { describe, it, expect } from 'vitest'
import { mimeDaNomeFile, mimeMigliore } from '../src/core/mime.js'

describe('mimeDaNomeFile', () => {
  it('riconosce i formati che i clienti mandano davvero', () => {
    expect(mimeDaNomeFile('image-16-09-26-06-30.jpeg')).toBe('image/jpeg')
    expect(mimeDaNomeFile('FOTO.JPG')).toBe('image/jpeg')
    expect(mimeDaNomeFile('140140014557023229.pdf')).toBe('application/pdf')
  })

  it('su un formato che non conosce resta null, non inventa un tipo', () => {
    expect(mimeDaNomeFile('archivio.xyz')).toBeNull()
    expect(mimeDaNomeFile('senza-estensione')).toBeNull()
    expect(mimeDaNomeFile(null)).toBeNull()
  })
})

describe('mimeMigliore', () => {
  it('tiene il tipo dichiarato quando dice qualcosa', () => {
    expect(mimeMigliore('image/png', 'foto.jpg')).toBe('image/png')
  })

  it('toglie i parametri dal Content-Type', () => {
    expect(mimeMigliore('image/jpeg; charset=binary', 'foto.jpg')).toBe('image/jpeg')
  })

  it('ripiega sul nome del file quando il tipo è generico o assente', () => {
    // Il caso reale: Mirakl elenca solo id/nome/dimensione, e il
    // download può rispondere con un tipo che non dice niente.
    expect(mimeMigliore('application/octet-stream', 'foto.jpeg')).toBe('image/jpeg')
    expect(mimeMigliore(null, 'documento.pdf')).toBe('application/pdf')
    expect(mimeMigliore('', 'foto.png')).toBe('image/png')
  })

  it('senza tipo e senza estensione nota resta null', () => {
    expect(mimeMigliore(null, 'allegato')).toBeNull()
  })
})
