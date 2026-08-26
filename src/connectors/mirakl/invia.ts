import type { Db } from '../../db/index.js'
import type { Logger } from '../../logger.js'
import { ClientMirakl, costruisciOperatori } from './client.js'

/**
 * Risposta a un thread Mirakl — M12, `POST /inbox/threads/{id}/message`.
 *
 * Qui non c'è il problema dell'identità che abbiamo con l'email: si
 * risponde dentro il thread, autenticati come negozio, e il messaggio
 * arriva dove deve. È il vantaggio di avere una API vera.
 */

export interface RichiestaInvioMirakl {
  thread_id: string
  agent_id: string | null
  testo: string
}

export interface EsitoInvioMirakl {
  message_id: string
  external_thread_id: string
}

export async function inviaMessaggioMirakl(
  db: Db,
  log: Logger,
  richiesta: RichiestaInvioMirakl,
  env: NodeJS.ProcessEnv = process.env,
): Promise<EsitoInvioMirakl> {
  const [thread] = await db<
    {
      external_thread_id: string | null
      account_id: string
      code: string
      display_name: string
      config: { endpoint?: unknown } | null
      secret_ref: string | null
    }[]
  >`
    select t.external_thread_id, t.account_id,
           ca.code, ca.display_name, ca.config, ca.secret_ref
    from thread t
    join channel_account ca on ca.id = t.account_id
    where t.id = ${richiesta.thread_id}
  `

  if (!thread) throw new Error(`Conversazione ${richiesta.thread_id} inesistente.`)
  if (!thread.external_thread_id) {
    throw new Error(
      `La conversazione ${richiesta.thread_id} non ha un identificativo Mirakl: ` +
        'non è stata importata dall\'API e non si può rispondere così.',
    )
  }

  const [operatore] = costruisciOperatori(
    [
      {
        id: thread.account_id,
        code: thread.code,
        display_name: thread.display_name,
        config: thread.config,
        secret_ref: thread.secret_ref,
      },
    ],
    env,
    log,
  )
  if (!operatore) {
    throw new Error(
      `Operatore ${thread.code} non configurato: mancano endpoint o chiave API.`,
    )
  }

  const client = new ClientMirakl(operatore, log)
  const risposta = await client.post<{ id?: unknown }>(
    `/inbox/threads/${encodeURIComponent(thread.external_thread_id)}/message`,
    { body: richiesta.testo },
  )

  // Se Mirakl restituisce l'id del messaggio lo usiamo come chiave
  // esterna: al prossimo giro di sincronizzazione lo stesso messaggio
  // tornerà indietro dall'API e non deve duplicarsi.
  const externalId =
    typeof risposta?.id === 'string' && risposta.id ? risposta.id : null

  const [riga] = await db<{ id: string }[]>`
    insert into message (
      thread_id, direction, author_kind, external_id, body_text,
      sent_at, delivery_state, match_strategy, raw
    ) values (
      ${richiesta.thread_id}, 'out', 'agent', ${externalId}, ${richiesta.testo},
      ${new Date()}, 'inviato', 'api', ${db.json({ risposta } as never)}
    )
    on conflict (thread_id, external_id) do nothing
    returning id
  `

  await db`
    update thread set state = 'pending_customer', updated_at = now()
    where id = ${richiesta.thread_id}
  `

  if (richiesta.agent_id) {
    await db`
      insert into audit_log (agent_id, azione, entita, entita_id, dati)
      values (${richiesta.agent_id}, 'risposta_inviata_mirakl', 'thread',
              ${richiesta.thread_id}, ${db.json({ operatore: operatore.code })})
    `
  }

  log.info(
    { thread_id: richiesta.thread_id, operatore: operatore.code },
    'risposta Mirakl inviata',
  )

  return {
    message_id: riga?.id ?? '',
    external_thread_id: thread.external_thread_id,
  }
}
