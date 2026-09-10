/**
 * Prova del controllo rientri magazzino, da lanciare a mano.
 *
 *   npm run magazzino:check
 *
 * Interroga l'endpoint di sola lettura del tool di magazzino, mostra
 * quanti rientri risultano riconoscibili come nostri ordini Amazon e
 * fa girare davvero l'elaborazione (scrive la nota e riapre il ticket
 * sui match nuovi — è lo stesso codice del giro periodico).
 */
import { loadConfig } from '../config.js'
import { createDb } from '../db/index.js'
import { logger } from '../logger.js'
import { estraiNumeroOrdineDaRiferimento, recuperaRientri, elaboraRientri } from '../connectors/magazzino/rientri.js'

const config = loadConfig()
const db = createDb(config)

try {
  const rientri = await recuperaRientri(config)
  console.log(`Rientri letti dal tool di magazzino: ${rientri.length}`)

  const riconosciuti = rientri.filter((r) => estraiNumeroOrdineDaRiferimento(r.internal_reference))
  console.log(`  di cui riconoscibili come ordini Amazon: ${riconosciuti.length}`)
  for (const r of riconosciuti.slice(0, 20)) {
    console.log(`    - ${estraiNumeroOrdineDaRiferimento(r.internal_reference)} (${r.customer_name ?? '—'}, ${r.created_at})`)
  }

  console.log('')
  const esito = await elaboraRientri(db, logger, rientri)
  console.log('Esito elaborazione:', esito)
} finally {
  await db.end({ timeout: 5 })
}
