/**
 * Registra i webhook Shopify.
 *
 *   npm run shopify:webhooks -- https://hub-messaggi-worker.onrender.com
 *
 * L'indirizzo si passa come argomento e non da variabile d'ambiente:
 * cambia da installazione a installazione, e non deve finire nel codice
 * né in un file di configurazione condiviso.
 *
 * È idempotente: legge cosa esiste già e crea solo il mancante.
 */
import { loadConfig } from '../config.js'
import { logger } from '../logger.js'
import { registraWebhook } from '../connectors/shopify/webhooks-registra.js'

const baseUrl = process.argv[2]

if (!baseUrl || !/^https:\/\//.test(baseUrl)) {
  console.error('')
  console.error("  Serve l'indirizzo pubblico del worker, in https.")
  console.error('  Esempio:')
  console.error('    npm run shopify:webhooks -- https://tuo-servizio.onrender.com')
  console.error('')
  process.exit(1)
}

const config = loadConfig()

try {
  const esiti = await registraWebhook(config, logger, baseUrl)
  console.log('')
  for (const e of esiti) {
    const riga = `  ${e.topic.padEnd(20)} ${e.esito}`
    console.log(e.dettaglio ? `${riga} — ${e.dettaglio}` : riga)
  }
  console.log('')
  if (esiti.some((e) => e.esito === 'errore')) process.exitCode = 1
} catch (errore) {
  console.error(`\n  ${errore instanceof Error ? errore.message : String(errore)}\n`)
  process.exitCode = 1
}
