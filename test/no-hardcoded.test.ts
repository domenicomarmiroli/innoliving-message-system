import { describe, it, expect } from 'vitest'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'

/**
 * Regola di replicabilità: nel codice non devono comparire valori
 * specifici di questa azienda. Arrivano da channel_account, da
 * app_config o dalle variabili d'ambiente.
 *
 * Se un giorno serve una seconda installazione, questo test è ciò che
 * impedisce che i valori rientrino per distrazione.
 */
const VIETATI = [
  'innoliving',
  'inshopping',
  'mediamarkt',
  'leroymerlin',
  'marketplace.amazon.it',
  'notification.mirakl.net',
]

function fileTs(dir: string): string[] {
  return readdirSync(dir).flatMap((n) => {
    const p = join(dir, n)
    if (statSync(p).isDirectory()) return fileTs(p)
    return p.endsWith('.ts') ? [p] : []
  })
}

describe('replicabilità', () => {
  it('nessun valore specifico di questa azienda nel sorgente', () => {
    const colpevoli: string[] = []
    for (const f of fileTs('src')) {
      const testo = readFileSync(f, 'utf8').toLowerCase()
      for (const v of VIETATI) {
        if (testo.includes(v)) colpevoli.push(`${f} contiene "${v}"`)
      }
    }
    expect(colpevoli).toEqual([])
  })
})
