import type { Db } from '../../db/index.js'
import type { Logger } from '../../logger.js'
import { riassumiErrore } from './collegamenti.js'

/**
 * Un invio che non parte lascia traccia (regola 5).
 *
 * Prima di questo un fallimento finiva solo nel log di Render: nel ticket
 * nessun segno, nessuna riga in `ingest_anomaly`, e il testo scritto
 * dall'operatore esisteva solo nell'editor (ticket 16121, 13/11, Outlook
 * giù). Ora il ticket riceve una nota interna con l'errore e il testo da
 * rimandare, e l'anomalia si registra con l'errore (senza il testo: quello
 * sta nella nota, regola 8).
 */
export async function registraInvioFallito(
  db: Db,
  log: Logger,
  dati: {
    thread_id: string | null
    agent_id: string | null | undefined
    testo: string
    errore: unknown
    /** Cosa si stava facendo: 'risposta', 'ticket collegato', 'nuovo ticket'. */
    azione: string
  },
): Promise<void> {
  const motivo = riassumiErrore(dati.errore)
  try {
    if (dati.thread_id) {
      await db`
        insert into message (thread_id, direction, author_kind, agent_id, body_text, interno, sent_at)
        values (${dati.thread_id}, 'out', 'agent', ${dati.agent_id ?? null},
                ${`⚠ ${dati.azione[0]!.toUpperCase()}${dati.azione.slice(1)} NON partita (o non confermata): ${motivo}\n\nIl testo è qui sotto: si può rimandare quando il problema è risolto.\n\n---\n${dati.testo}`},
                true, now())
      `
    }
    await db`
      insert into ingest_anomaly (tipo, payload)
      values ('invio_fallito', ${db.json({ thread_id: dati.thread_id, azione: dati.azione, errore: motivo })})
    `
  } catch (errore) {
    log.error({ thread_id: dati.thread_id, err: riassumiErrore(errore) }, 'registrazione dell\'invio fallito non riuscita')
  }
}
