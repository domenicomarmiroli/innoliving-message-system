import type { Config } from '../../config.js'
import type { Db } from '../../db/index.js'
import type { Logger } from '../../logger.js'
import { credenzialiMancanti, leggiCasella, messaggioErrore } from './imap.js'
import { riaggancia } from './riaggancia.js'
import { sincronizzaMirakl } from '../mirakl/sync.js'

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
      // Le conversazioni senza ordine si riprovano a ogni giro: un
      // messaggio può arrivare prima del suo ordine, e quando l'ordine
      // compare devono agganciarsi da sole senza che nessuno lanci nulla.
      const ri = await riaggancia(db, log)

      // Mirakl ha una API vera: si chiede cosa è cambiato invece di
      // aspettare che arrivi una email. Gira sullo stesso ritmo della
      // casella perché la reattività richiesta è la stessa, e un
      // errore qui non deve fermare la lettura della posta.
      let mirakl = 0
      try {
        const esiti = await sincronizzaMirakl(db, log)
        mirakl = esiti.reduce((n, e) => n + e.messaggi_inseriti, 0)
      } catch (errore) {
        log.error({ err: messaggioErrore(errore) }, 'sincronizzazione Mirakl fallita')
      }

      fallimenti = 0
      // Silenzio quando non c'è niente: un log al minuto che dice "zero"
      // rende illeggibile quello che conta.
      if (esito.lette > 0 || ri.agganciate > 0 || mirakl > 0) {
        log.info(
          { ...esito, agganciate: ri.agganciate, mirakl_messaggi: mirakl },
          'giro completato',
        )
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
