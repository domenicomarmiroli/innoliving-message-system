import { createHash } from 'node:crypto'

import type { Config } from '../../config.js'
import type { Db } from '../../db/index.js'
import type { Logger } from '../../logger.js'
import { dimensioniImmagine } from '../../core/immagine.js'
import { caricaAllegato, storageConfigurato } from '../../core/storage.js'
import type { FilePronto } from '../../core/attachments/normalize.js'
import { ClientMirakl, costruisciOperatori } from './client.js'

/**
 * Risposta a un thread Mirakl — M12, `POST /inbox/threads/{id}/message`.
 *
 * Qui non c'è il problema dell'identità che abbiamo con l'email: si
 * risponde dentro il thread, autenticati come negozio, e il messaggio
 * arriva dove deve. È il vantaggio di avere una API vera.
 *
 * Con allegati, M12 accetta multipart/form-data con `message_input.body`
 * e `files[]` — verificato sulla documentazione pubblica (non ancora su
 * un invio reale con file: nessun cliente Mirakl ha ancora scritto).
 * OR74 ("carica documenti per un ordine") non è questo: è a livello di
 * ordine, non di thread di messaggistica — scartato dopo aver letto la
 * documentazione, non solo il runbook originale.
 */

export interface RichiestaInvioMirakl {
  thread_id: string
  agent_id: string | null
  testo: string
  allegati?: FilePronto[]
}

export interface EsitoInvioMirakl {
  message_id: string
  external_thread_id: string
}

export async function inviaMessaggioMirakl(
  db: Db,
  log: Logger,
  config: Config,
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
  const percorsoInvio = `/inbox/threads/${encodeURIComponent(thread.external_thread_id)}/message`

  const risposta =
    richiesta.allegati && richiesta.allegati.length > 0
      ? await (() => {
          const form = new FormData()
          form.append('message_input.body', richiesta.testo)
          for (const a of richiesta.allegati!) {
            form.append('files', new Blob([new Uint8Array(a.contenuto)], { type: a.mime }), a.nome_file)
          }
          return client.postMultipart<{ id?: unknown }>(percorsoInvio, form)
        })()
      : await client.post<{ id?: unknown }>(percorsoInvio, { body: richiesta.testo })

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

  // Registriamo il file COME È PARTITO, non solo quello scelto
  // dall'agente — stesso principio dell'invio via email.
  if (riga && richiesta.allegati) {
    for (const a of richiesta.allegati) {
      const checksum = createHash('sha256').update(a.contenuto).digest('hex')
      let storage_path: string | null = null
      if (storageConfigurato(config)) {
        try {
          storage_path = await caricaAllegato(
            config,
            `mirakl/out/${riga.id}/${checksum}-${a.nome_file}`,
            a.contenuto,
            a.mime,
          )
        } catch (errore) {
          log.error(
            { err: errore instanceof Error ? errore.message : String(errore) },
            "upload su Storage dell'allegato Mirakl in uscita fallito: registrato solo il metadato",
          )
        }
      }
      const dimensioni = await dimensioniImmagine(a.contenuto)
      await db`
        insert into attachment (
          message_id, direzione, nome_file, mime, dimensione_byte, checksum,
          storage_path, convertito_da, larghezza, altezza
        ) values (
          ${riga.id}, 'out', ${a.nome_file}, ${a.mime}, ${a.contenuto.byteLength}, ${checksum},
          ${storage_path}, ${a.convertito_da}, ${dimensioni?.larghezza ?? null}, ${dimensioni?.altezza ?? null}
        )
      `
    }
  }

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
