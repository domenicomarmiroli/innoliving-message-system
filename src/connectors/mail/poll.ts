import type { Config } from '../../config.js'
import type { Db } from '../../db/index.js'
import type { Logger } from '../../logger.js'
import { credenzialiMancanti, leggiCasella, messaggioErrore } from './imap.js'

/**
 * Il ciclo che tiene la casella sotto controllo.
 *
 * IMAP non avvisa: bisogna chiedere. Ogni MAIL_POLL_SECONDI il worker
 * rilegge da dove era rimasto. Con qualche decina di messaggi al giorno
 * un minuto è abbondante, e il costo di una connessione a vuoto è nullo.
 *
 * Un errore non ferma il ciclo: la rete cade, Gmail limita, il database
 * si riavvia. Aspettiamo di più a ogni fallimento consecutivo — fino a
 * dieci minuti — e riprendiamo il ritmo appena torna a funzionare.
 */

const ATTESA_MASSIMA_MS = 10 * 60_000

export interface Ciclo {
  ferma(): void
}

export function avviaPolling(db: Db, log: Logger, config: Config): Ciclo | null {
  const mancanti = credenzialiMancanti(config)
  if (mancanti.length > 0) {
    log.warn(
      { mancanti },
      'casella non configurata: il polling non parte (il resto del worker funziona)',
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
      const esito = await leggiCasella(db, log, config)
      fallimenti = 0
      // Silenzio quando non c'è niente: un log al minuto che dice "zero"
      // rende illeggibile quello che conta.
      if (esito.lette > 0) {
        log.info(esito, 'casella letta')
      }
    } catch (errore) {
      fallimenti += 1
      log.error(
        { tentativi_falliti: fallimenti, err: messaggioErrore(errore) },
        'lettura della casella fallita',
      )
    } finally {
      if (!fermato) timer = setTimeout(() => void giro(), attesa())
    }
  }

  log.info({ ogni_secondi: config.MAIL_POLL_SECONDS }, 'polling della casella avviato')
  void giro()

  return {
    ferma() {
      fermato = true
      if (timer) clearTimeout(timer)
    },
  }
}
