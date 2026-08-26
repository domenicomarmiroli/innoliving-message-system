import type { Db } from '../../db/index.js'
import type { Logger } from '../../logger.js'
import type { OperatoreMirakl } from './client.js'
import type { ThreadMirakl } from './normalize.js'

/**
 * Scrittura idempotente di un thread Mirakl.
 *
 * Qui abbiamo qualcosa che con Amazon non avevamo: identificativi veri.
 * Il thread ha un id suo e ogni messaggio pure, quindi il vincolo
 * (account_id, external_thread_id) e (thread_id, external_id) fanno
 * tutto il lavoro. Rileggere gli stessi thread all'infinito non duplica
 * niente, e non serve inventare chiavi.
 *
 * L'aggancio all'ordine è esatto e non richiede di interpretare testo:
 * l'entità MMP_ORDER del thread contiene l'identificativo dell'ordine,
 * che è lo stesso `external_order_id` che abbiamo importato da Shopify.
 */

export interface RisultatoThread {
  thread_id: string
  nuovo: boolean
  messaggi_inseriti: number
  agganciato: boolean
}

export async function upsertThread(
  db: Db,
  log: Logger,
  operatore: OperatoreMirakl,
  t: ThreadMirakl,
  giorniCoda: number,
): Promise<RisultatoThread> {
  return db.begin(async (tx) => {
    const aggiornato = t.aggiornato_il ? new Date(t.aggiornato_il) : new Date()
    const creato = t.creato_il ? new Date(t.creato_il) : aggiornato
    const vecchio = (Date.now() - aggiornato.getTime()) / 86_400_000 > giorniCoda

    // --- L'ordine, se il thread ne cita uno --------------------------
    let orderId: string | null = null
    if (t.external_order_id) {
      const [ordine] = await tx<{ id: string }[]>`
        select id from "order"
        where channel = 'mirakl' and external_order_id = ${t.external_order_id}
        limit 1
      `
      orderId = ordine?.id ?? null
      if (!orderId) {
        // Non è un errore: l'ordine può non essere ancora arrivato da
        // Shopify. Il riaggancio periodico ci ripasserà.
        log.info(
          { operatore: operatore.code, ordine: t.external_order_id },
          'thread Mirakl su un ordine non ancora in archivio',
        )
      }
    }

    // --- SLA del canale ------------------------------------------------
    const [account] = await tx<{ sla_minutes: number }[]>`
      select sla_minutes from channel_account where id = ${operatore.account_id}
    `
    const scadenza = new Date(
      aggiornato.getTime() + (account?.sla_minutes ?? 1440) * 60_000,
    )

    const [riga] = await tx<{ id: string; created: boolean }[]>`
      insert into thread (
        account_id, external_thread_id, order_id, subject, state,
        first_inbound_at, last_inbound_at, due_at
      ) values (
        ${operatore.account_id}, ${t.external_thread_id}, ${orderId},
        ${t.oggetto}, ${vecchio ? 'closed' : orderId ? 'new' : 'unmatched'},
        ${creato}, ${aggiornato}, ${scadenza}
      )
      on conflict (account_id, external_thread_id)
        where external_thread_id is not null
      do update set
        subject        = coalesce(thread.subject, excluded.subject),
        -- Non azzerare un aggancio già fatto con un valore vuoto.
        order_id       = coalesce(excluded.order_id, thread.order_id),
        last_inbound_at = greatest(
          coalesce(thread.last_inbound_at, excluded.last_inbound_at),
          excluded.last_inbound_at
        ),
        updated_at     = now()
      returning id, (xmax = 0) as created
    `

    const threadId = riga!.id
    let inseriti = 0

    for (const m of t.messaggi) {
      if (!m.external_id) continue // senza id non è idempotente: si salta

      const [scritto] = await tx<{ id: string }[]>`
        insert into message (
          thread_id, direction, author_kind, external_id, body_text,
          sent_at, match_strategy, raw
        ) values (
          ${threadId}, ${m.direzione},
          ${m.direzione === 'out' ? 'agent' : 'customer'},
          ${m.external_id}, ${m.corpo},
          ${m.inviato_il ? new Date(m.inviato_il) : aggiornato},
          'api', ${tx.json(m.raw as never)}
        )
        on conflict (thread_id, external_id) do nothing
        returning id
      `
      if (!scritto) continue
      inseriti += 1

      for (const a of m.allegati) {
        await tx`
          insert into attachment (
            message_id, direzione, nome_file, dimensione_byte, checksum
          ) values (
            ${scritto.id}, ${m.direzione}, ${a.nome_file},
            ${a.dimensione_byte}, ${a.external_id ?? ''}
          )
        `
      }
    }

    // Un messaggio nuovo del cliente riapre una conversazione chiusa;
    // uno vecchio, importato dallo storico, no.
    if (inseriti > 0 && !vecchio) {
      await tx`
        update thread set
          state  = case when state in ('closed','pending_customer') then 'open' else state end,
          due_at = ${scadenza},
          updated_at = now()
        where id = ${threadId}
      `
    }

    return {
      thread_id: threadId,
      nuovo: riga!.created,
      messaggi_inseriti: inseriti,
      agganciato: orderId !== null,
    }
  })
}
