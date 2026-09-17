import type { Config } from '../../config.js'
import type { Db } from '../../db/index.js'
import type { Logger } from '../../logger.js'
import { storageConfigurato } from '../../core/storage.js'
import type { ClientMirakl } from './client.js'
import type { OperatoreMirakl } from './client.js'
import { scaricaAllegatoMirakl } from './upsert.js'

/**
 * Riprova a scaricare gli allegati Mirakl entrati come solo metadato.
 *
 * Perché dentro il giro periodico e non solo in un comando a mano: la
 * sincronizzazione non ripassa un messaggio che esiste già, quindi una
 * riga senza file resterebbe vuota per sempre anche dopo aver corretto
 * il motivo del fallimento. Stessa idea di `riaggancia.ts`: quello che
 * non è riuscito una volta si riprova al giro dopo, e il giorno in cui
 * la causa sparisce si sistema da solo.
 *
 * Due limiti tengono il costo sotto controllo:
 * - una finestra di {@link GIORNI_FINESTRA} giorni, così un allegato
 *   che il marketplace non serve più non viene richiesto in eterno;
 * - al massimo {@link PER_GIRO} tentativi per operatore per giro, per
 *   non trasformare un arretrato in una raffica di richieste.
 *
 * L'identificativo Mirakl dell'allegato sta nella colonna `checksum`:
 * su una riga senza file non c'è nessuna impronta dei byte da salvarci
 * (i byte non li abbiamo mai avuti), e ci viene messo l'id — che è
 * appunto ciò che serve a M13 per richiederlo.
 */

const GIORNI_FINESTRA = 30
const PER_GIRO = 20

export async function recuperaAllegatiMancanti(
  db: Db,
  log: Logger,
  config: Config,
  client: ClientMirakl,
  operatore: OperatoreMirakl,
): Promise<number> {
  if (!storageConfigurato(config)) return 0

  const righe = await db<
    { id: string; nome_file: string | null; dimensione_byte: number | null; checksum: string }[]
  >`
    select a.id, a.nome_file, a.dimensione_byte, a.checksum
    from attachment a
    join message m on m.id = a.message_id
    join thread t on t.id = m.thread_id
    where t.account_id = ${operatore.account_id}
      and a.storage_path is null
      and a.checksum is not null
      and a.created_at > now() - ${`${GIORNI_FINESTRA} days`}::interval
    order by a.created_at desc
    limit ${PER_GIRO}
  `
  if (righe.length === 0) return 0

  let recuperati = 0
  for (const r of righe) {
    try {
      const pronto = await scaricaAllegatoMirakl(config, client, {
        external_id: r.checksum,
        nome_file: r.nome_file,
        dimensione_byte: r.dimensione_byte,
      })
      await db`
        update attachment
        set storage_path = ${pronto.storage_path},
            mime = ${pronto.mime},
            checksum = ${pronto.checksum},
            larghezza = ${pronto.larghezza},
            altezza = ${pronto.altezza}
        where id = ${r.id}
      `
      recuperati += 1
    } catch (errore) {
      // Solo un avviso: il fallimento della PRIMA volta è già in
      // ingest_anomaly, e ripetere lì la stessa riga ad ogni giro
      // trasformerebbe la tabella degli errori in un registro di
      // tentativi.
      log.warn(
        {
          operatore: operatore.code,
          allegato: r.checksum,
          err: errore instanceof Error ? errore.message : String(errore),
        },
        'nuovo tentativo di scaricare un allegato Mirakl non riuscito',
      )
    }
  }

  if (recuperati > 0) {
    log.info({ operatore: operatore.code, recuperati }, 'allegati Mirakl recuperati')
  }
  return recuperati
}
