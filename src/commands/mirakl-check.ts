/**
 * Prova dei connettori Mirakl, da lanciare a mano.
 *
 *   npm run mirakl:check              un giro di sincronizzazione vera
 *   npm run mirakl:check -- --forma   NON scrive: mostra la STRUTTURA
 *                                     della risposta, campo per campo
 *
 * `--forma` è la modalità che conta. Questo connettore è stato scritto
 * sulla documentazione, perché quando l'abbiamo fatto nessun cliente
 * Mirakl aveva ancora scritto e l'API restituiva una lista vuota.
 * Appena arriva la prima conversazione vera, questo comando dice in un
 * colpo solo se i nomi dei campi che ci aspettiamo esistono davvero —
 * senza stampare il contenuto dei messaggi.
 */
import { loadConfig } from '../config.js'
import { createDb } from '../db/index.js'
import { logger } from '../logger.js'
import { ClientMirakl, costruisciOperatori } from '../connectors/mirakl/client.js'
import { normalizzaRisposta } from '../connectors/mirakl/normalize.js'
import { sincronizzaMirakl } from '../connectors/mirakl/sync.js'

const soloForma = process.argv.includes('--forma')
const config = loadConfig()
const db = createDb(config)

try {
  if (soloForma) {
    const righe = await db<
      {
        id: string
        code: string
        display_name: string
        config: { endpoint?: unknown } | null
        secret_ref: string | null
      }[]
    >`
      select id, code, display_name, config, secret_ref
      from channel_account where kind = 'mirakl' and active order by code
    `
    const operatori = costruisciOperatori(righe, process.env, logger)

    if (operatori.length === 0) {
      console.error('\nNessun operatore Mirakl configurato.')
      console.error('Servono config.endpoint e secret_ref in channel_account,')
      console.error("e la variabile d'ambiente indicata da secret_ref.\n")
      process.exit(1)
    }

    for (const op of operatori) {
      console.log(`\n=== ${op.display_name} (${op.code}) ===`)
      const client = new ClientMirakl(op, logger)
      const risposta = await client.get<Record<string, unknown>>('/inbox/threads', {
        with_messages: 'true',
        limit: '3',
      })

      console.log('  chiavi di primo livello:', Object.keys(risposta).join(', '))

      const dati = risposta.data
      if (!Array.isArray(dati) || dati.length === 0) {
        console.log('  nessuna conversazione: niente da verificare, per ora.')
        continue
      }

      const primo = dati[0] as Record<string, unknown>
      console.log('  campi del thread:  ', Object.keys(primo).join(', '))

      const messaggi = primo.messages
      if (Array.isArray(messaggi) && messaggi.length > 0) {
        const m = messaggi[0] as Record<string, unknown>
        console.log('  campi del messaggio:', Object.keys(m).join(', '))
        const from = m.from as Record<string, unknown> | undefined
        if (from) {
          console.log('  campi di "from":   ', Object.keys(from).join(', '))
          console.log('  from.type vale:    ', JSON.stringify(from.type))
        }
      }

      const entita = primo.entities
      if (Array.isArray(entita) && entita.length > 0) {
        console.log(
          '  entità:            ',
          entita
            .map((e) => (e as Record<string, unknown>)?.type)
            .filter(Boolean)
            .join(', '),
        )
      }

      // La prova del nove: il normalizzatore capisce questa risposta?
      const norm = normalizzaRisposta(risposta)
      console.log(`  interpretati:       ${norm.threads.length} thread`)
      console.log(
        `  con ordine:         ${norm.threads.filter((t) => t.external_order_id).length}`,
      )
      console.log(
        `  messaggi:           ${norm.threads.reduce((n, t) => n + t.messaggi.length, 0)}`,
      )
      if (norm.stranezze.length > 0) {
        console.log('  DA CORREGGERE:')
        for (const s of norm.stranezze) {
          console.log(`   - ${s.tipo}: ${JSON.stringify(s.dettaglio)}`)
        }
      } else {
        console.log('  nessuna stranezza: i campi corrispondono.')
      }
    }
    console.log('')
  } else {
    const esiti = await sincronizzaMirakl(db, logger, config)
    if (esiti.length === 0) {
      console.log('\nNessun operatore Mirakl configurato.\n')
    }
    for (const e of esiti) {
      console.log('')
      console.log(`  ${e.operatore}`)
      console.log('    thread visti:      ', e.thread_visti)
      console.log('    thread nuovi:      ', e.thread_nuovi)
      console.log('    messaggi inseriti: ', e.messaggi_inseriti)
      console.log('    agganciati a ordine:', e.agganciati)
      console.log('    stranezze:         ', e.stranezze)
      if (e.errore) console.log('    ERRORE:            ', e.errore)
    }
    console.log('')
  }
} finally {
  await db.end({ timeout: 5 })
}
