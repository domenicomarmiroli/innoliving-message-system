import type { Db } from '../../db/index.js'
import type { Logger } from '../../logger.js'
import { sanificaPerRegistro } from '../../core/voce/oscura.js'

/**
 * Registro delle chiamate agli strumenti vocali (`voice_log`).
 *
 * Una riga per ogni richiesta a /voce/*, anche quelle rifiutate: un 401
 * ripetuto è il primo segnale di un secret sbagliato in ElevenLabs, o di
 * qualcuno che prova a indovinarlo. La richiesta si salva solo dopo
 * `sanificaPerRegistro()`, mai com'è arrivata.
 */

export interface RigaRegistroVoce {
  conversation_id: string | null
  tool: string
  richiesta: unknown
  response_status: number
  esito: string | null
  latency_ms: number | null
}

export async function registraChiamataVoce(db: Db, log: Logger, riga: RigaRegistroVoce): Promise<void> {
  try {
    await db`
      insert into voice_log (conversation_id, tool, request_sanitized, response_status, esito, latency_ms)
      values (
        ${riga.conversation_id}, ${riga.tool},
        ${db.json(sanificaPerRegistro(riga.richiesta) as never)},
        ${riga.response_status}, ${riga.esito}, ${riga.latency_ms}
      )
    `
  } catch (errore) {
    // La risposta all'agente è già partita: un registro che non si scrive
    // non deve diventare un errore per il cliente al telefono. Resta nei
    // log dell'applicazione, senza la richiesta.
    log.error(
      { tool: riga.tool, err: errore instanceof Error ? errore.message : String(errore) },
      'scrittura del registro voce fallita',
    )
  }
}
