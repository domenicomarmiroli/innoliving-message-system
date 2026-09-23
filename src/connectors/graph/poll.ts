import type { Config } from '../../config.js'
import type { Db } from '../../db/index.js'
import type { Logger } from '../../logger.js'
import type { Ciclo } from '../mail/poll.js'
import { credenzialiGraphMancanti } from './client.js'
import { leggiCasellaGraph } from './lettura.js'

/**
 * Il ciclo della casella Microsoft 365.
 *
 * **Indipendente da quello Gmail, di proposito.** Durante la migrazione
 * le due caselle vivono insieme: se una si rompe (un secret scaduto, un
 * permesso revocato, Gmail che limita) l'altra deve continuare a
 * leggere. Metterle nello stesso giro avrebbe voluto dire che un 403 di
 * Microsoft ferma anche la posta che arriva su Gmail.
 *
 * Non ripete il riaggancio né la sincronizzazione Mirakl: quelli girano
 * già nel ciclo principale (`mail/poll.ts`) e non dipendono da quale
 * casella ha portato il messaggio. Farli due volte non romperebbe niente
 * — sono idempotenti — ma raddoppierebbe le chiamate a Mirakl.
 *
 * Stesso ritmo e stessa attesa crescente sui fallimenti del ciclo Gmail:
 * `MAIL_POLL_SECONDS`, fino a dieci minuti fra un tentativo e l'altro.
 */

const ATTESA_MASSIMA_MS = 10 * 60_000

export function avviaPollingGraph(db: Db, log: Logger, config: Config): Ciclo | null {
  const mancanti = credenzialiGraphMancanti(config)
  if (mancanti.length > 0) {
    // Non un errore: finché il secret non c'è, la casella Microsoft
    // semplicemente non è ancora accesa.
    log.info(
      { mancanti },
      'casella Microsoft non configurata: il suo ciclo non parte (Gmail e il resto funzionano)',
    )
    return null
  }

  let fermato = false
  let timer: NodeJS.Timeout | null = null
  let fallimenti = 0

  const attesa = (): number => {
    const base = config.MAIL_POLL_SECONDS * 1000
    if (fallimenti === 0) return base
    return Math.min(base * 2 ** fallimenti, ATTESA_MASSIMA_MS)
  }

  const giro = async (): Promise<void> => {
    if (fermato) return
    try {
      const esito = await leggiCasellaGraph(db, log, config)
      fallimenti = 0
      // Silenzio quando non c'è niente: un log al minuto che dice "zero"
      // rende illeggibile quello che conta.
      if (esito.lette > 0) log.info({ ...esito, casella: 'graph' }, 'giro casella Microsoft completato')
    } catch (errore) {
      fallimenti += 1
      log.error(
        {
          tentativi_falliti: fallimenti,
          err: errore instanceof Error ? errore.message : String(errore),
        },
        'lettura della casella Microsoft fallita',
      )
    } finally {
      if (!fermato) timer = setTimeout(() => void giro(), attesa())
    }
  }

  log.info({ ogni_secondi: config.MAIL_POLL_SECONDS }, 'polling della casella Microsoft avviato')
  void giro()

  return {
    ferma() {
      fermato = true
      if (timer) clearTimeout(timer)
    },
  }
}
