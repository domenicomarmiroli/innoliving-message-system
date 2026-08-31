import { createHash } from 'node:crypto'

import type { Config } from '../../config.js'
import type { Db } from '../../db/index.js'
import type { Logger } from '../../logger.js'
import { dimensioniImmagine } from '../../core/immagine.js'
import { caricaAllegato, storageConfigurato } from '../../core/storage.js'
import { ClientMirakl, type OperatoreMirakl } from './client.js'
import type { AllegatoMirakl, ThreadMirakl } from './normalize.js'

interface AllegatoMiraklPronto extends AllegatoMirakl {
  checksum: string
  mime: string | null
  storage_path: string | null
  larghezza: number | null
  altezza: number | null
}

/**
 * Scarica ogni allegato via M13 e lo carica su Storage, PRIMA di aprire
 * la transazione database — stesso motivo della casella email: è I/O di
 * rete, non deve tenere lock aperti.
 *
 * DEBITO — come il resto di questo connettore: il percorso M13
 * (`/inbox/threads/{attachment_id}/download`) è scritto sulla
 * documentazione pubblica, non verificato su una risposta reale. Se il
 * download fallisce, l'allegato entra comunque come solo metadato — un
 * file mancante pesa meno di un messaggio perso — e l'errore finisce nei
 * log, non silenziosamente ignorato.
 */
async function preparaAllegatiMirakl(
  config: Config,
  log: Logger,
  client: ClientMirakl,
  allegati: AllegatoMirakl[],
): Promise<AllegatoMiraklPronto[]> {
  if (allegati.length === 0) return []

  return Promise.all(
    allegati.map(async (a) => {
      const vuoto: AllegatoMiraklPronto = {
        ...a,
        checksum: a.external_id ?? '',
        mime: null,
        storage_path: null,
        larghezza: null,
        altezza: null,
      }
      if (!a.external_id || !storageConfigurato(config)) return vuoto

      try {
        const { contenuto, mime } = await client.download(
          `/inbox/threads/${encodeURIComponent(a.external_id)}/download`,
        )
        const checksum = createHash('sha256').update(contenuto).digest('hex')
        const dimensioni = await dimensioniImmagine(contenuto)
        const percorso = `mirakl/${client.code}/${checksum}-${a.nome_file ?? 'allegato'}`
        const storage_path = await caricaAllegato(config, percorso, contenuto, mime)
        return {
          ...a,
          checksum,
          mime,
          storage_path,
          larghezza: dimensioni?.larghezza ?? null,
          altezza: dimensioni?.altezza ?? null,
        }
      } catch (errore) {
        log.error(
          {
            operatore: client.code,
            allegato: a.external_id,
            err: errore instanceof Error ? errore.message : String(errore),
          },
          'download allegato Mirakl fallito: registrato solo il metadato',
        )
        return vuoto
      }
    }),
  )
}

/**
 * Scrittura idempotente di un thread Mirakl.
 *
 * Qui abbiamo qualcosa che con Amazon non avevamo: identificativi veri.
 * Il thread ha un id suo e ogni messaggio pure, quindi il vincolo
 * (account_id, external_thread_id) e (thread_id, external_id) fanno
 * quasi tutto il lavoro. **Quasi**: per i messaggi nostri (autore_kind
 * 'agent') non basta — verificato su un caso reale (31/08), un
 * messaggio spedito da `invia.ts` (M12, scrittura) è stato reimportato
 * qui come riga nuova al giro di sincronizzazione successivo (M11,
 * lettura), perché i due endpoint non riportano lo stesso external_id
 * per lo stesso messaggio. Per quelli, prima dell'insert, un controllo
 * in più per contenuto+orario oltre a quello per id.
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
  config: Config,
  operatore: OperatoreMirakl,
  t: ThreadMirakl,
  giorniCoda: number,
): Promise<RisultatoThread> {
  const client = new ClientMirakl(operatore, log)
  // Chiave: external_id del messaggio (unico nel thread); un messaggio
  // senza external_id viene comunque saltato più sotto, prima di arrivare
  // qui non serve prepararne gli allegati.
  const allegatiPerMessaggio = new Map<string, AllegatoMiraklPronto[]>()
  for (const m of t.messaggi) {
    if (!m.external_id || m.allegati.length === 0) continue
    allegatiPerMessaggio.set(
      m.external_id,
      await preparaAllegatiMirakl(config, log, client, m.allegati),
    )
  }

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

      // Un messaggio nostro (autore_kind='agent') può essere già stato
      // scritto da invia.ts al momento dell'invio, con l'external_id
      // restituito da M12 (scrittura) — che non è detto coincida con
      // quello che M11 (lettura, qui) riporta per lo STESSO messaggio.
      // Verificato su un caso reale (31/08): la sincronizzazione
      // periodica ha reinserito una risposta appena spedita come riga
      // nuova, duplicandola in interfaccia — il vincolo
      // (thread_id, external_id) non basta se i due endpoint non
      // concordano sull'id. Un secondo controllo per contenuto, in una
      // finestra di pochi minuti, evita il doppione anche quando gli id
      // non coincidono.
      if (m.autore_kind === 'agent' && m.corpo_testo) {
        const orarioMsg = m.inviato_il ? new Date(m.inviato_il) : aggiornato
        const [giaInviato] = await tx<{ id: string }[]>`
          select id from message
          where thread_id = ${threadId}
            and direction = 'out' and author_kind = 'agent'
            and body_text = ${m.corpo_testo}
            and sent_at between ${new Date(orarioMsg.getTime() - 120_000)}
                             and ${new Date(orarioMsg.getTime() + 120_000)}
          limit 1
        `
        if (giaInviato) continue
      }

      const [scritto] = await tx<{ id: string }[]>`
        insert into message (
          thread_id, direction, author_kind, external_id, body_text, body_html,
          sent_at, match_strategy, raw
        ) values (
          ${threadId}, ${m.direzione}, ${m.autore_kind},
          ${m.external_id}, ${m.corpo_testo}, ${m.corpo_html},
          ${m.inviato_il ? new Date(m.inviato_il) : aggiornato},
          'api', ${tx.json(m.raw as never)}
        )
        on conflict (thread_id, external_id) do nothing
        returning id
      `
      if (!scritto) continue
      inseriti += 1

      const allegatiPronti = m.external_id ? allegatiPerMessaggio.get(m.external_id) ?? [] : []
      for (const a of allegatiPronti) {
        await tx`
          insert into attachment (
            message_id, direzione, nome_file, mime, dimensione_byte, checksum,
            storage_path, larghezza, altezza
          ) values (
            ${scritto.id}, ${m.direzione}, ${a.nome_file}, ${a.mime},
            ${a.dimensione_byte}, ${a.checksum},
            ${a.storage_path}, ${a.larghezza}, ${a.altezza}
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
