/**
 * Verifica della casella, da lanciare a mano.
 *
 *   npm run mail:check
 *
 * Fa un solo giro di lettura e stampa cosa ha trovato. Serve la prima
 * volta, per sapere se le credenziali funzionano prima di lasciare
 * girare il polling in silenzio.
 */
import { loadConfig } from '../config.js'
import { createDb } from '../db/index.js'
import { logger } from '../logger.js'
import { credenzialiMancanti, leggiCasella, messaggioErrore } from '../connectors/mail/imap.js'

const config = loadConfig()
const mancanti = credenzialiMancanti(config)

if (mancanti.length > 0) {
  console.error(`Mancano queste variabili: ${mancanti.join(', ')}`)
  process.exit(1)
}

const db = createDb(config)

try {
  const esito = await leggiCasella(db, logger, config)
  console.log('')
  console.log('  lette:        ', esito.lette)
  console.log('  inserite:     ', esito.inserite)
  console.log('  già presenti: ', esito.gia_presenti)
  console.log('  errori:       ', esito.errori)
  console.log('  ultimo UID:   ', esito.ultimo_uid ?? '(nessuno)')
  console.log('')
  if (esito.lette === 0) {
    console.log('  Nessun messaggio nuovo. Se te ne aspettavi, controlla che')
    console.log('  non siano finiti in Spam e che MAIL_FOLDER sia la cartella giusta.')
    console.log('')
  }
} catch (errore) {
  const testo = messaggioErrore(errore)
  console.error(`\nLettura fallita: ${testo}\n`)
  if (/invalid credentials|authentication failed|AUTHENTICATIONFAILED/i.test(testo)) {
    console.error('  Cause tipiche, in ordine di frequenza:')
    console.error('   - la password per app è stata incollata con gli spazi')
    console.error('   - la verifica in due passaggi non è attiva sull account')
    console.error('   - la password per app è stata revocata o rigenerata')
    console.error('')
  }
  process.exitCode = 1
} finally {
  await db.end({ timeout: 5 })
}
