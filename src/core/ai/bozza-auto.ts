import type { Config } from '../../config.js'
import type { Db } from '../../db/index.js'
import type { Logger } from '../../logger.js'
import { generaBozza } from './draft.js'

/**
 * Bozza automatica: quando arriva un messaggio del cliente, la bozza è
 * già pronta quando l'operatore apre il ticket. Gira nel ciclo
 * principale, come la traduzione, e non spedisce MAI nulla: scrive solo
 * in ai_draft.
 *
 * Non rigenera inutilmente (ogni bozza costa crediti AI):
 *  - una bozza per messaggio cliente (`trigger_message_id`): se esiste
 *    già per l'ultimo messaggio, il thread non è candidato;
 *  - solo se l'ultimo messaggio del thread è del cliente: se ha già
 *    risposto qualcuno, o l'ultimo è una notifica automatica, niente;
 *  - non sui ticket chiusi né sui ticket collegati verso corriere o
 *    assistenza (lì il cliente non scrive);
 *  - finestra di 3 giorni e pochi per giro: è l'attesa di un operatore,
 *    non un backfill dello storico.
 * Il budget giornaliero dei lavori in background vale anche qui
 * (`sfondo: true`).
 */

const GIORNI_FINESTRA = 3
const MASSIMO_PER_GIRO = 5

export async function generaBozzeAutomatiche(db: Db, log: Logger, config: Config): Promise<number> {
  if (!config.ANTHROPIC_API_KEY) return 0

  const candidati = await db<{ thread_id: string }[]>`
    select t.id as thread_id
    from thread t
    join lateral (
      select id, direction, author_kind, sent_at
      from message
      where thread_id = t.id and interno = false
      order by sent_at desc
      limit 1
    ) u on true
    where t.state <> 'closed'
      and t.linked_thread_id is null
      and u.direction = 'in' and u.author_kind = 'customer'
      and u.sent_at > now() - make_interval(days => ${GIORNI_FINESTRA})
      and not exists (
        select 1 from ai_draft d where d.thread_id = t.id and d.trigger_message_id = u.id
      )
    order by u.sent_at desc
    limit ${MASSIMO_PER_GIRO}
  `

  let fatte = 0
  for (const c of candidati) {
    try {
      await generaBozza(db, log, config, c.thread_id, { sfondo: true })
      fatte += 1
    } catch (errore) {
      // Un fallimento non ferma gli altri: il thread resta candidato e si
      // riprova al giro dopo.
      log.warn(
        { thread_id: c.thread_id, err: errore instanceof Error ? errore.message : String(errore) },
        'bozza automatica non riuscita',
      )
    }
  }
  return fatte
}
