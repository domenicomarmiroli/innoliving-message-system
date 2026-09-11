import type { Db } from '../../db/index.js'
import type { Logger } from '../../logger.js'
import { anomalia } from './notifica.js'
import { perArchivio } from './parse.js'
import { estraiNumeroOrdine } from './riconosci.js'
import type { EmailGrezza } from './tipi.js'

/**
 * Richiesta di annullamento di un ordine (`X-Space-Notification-Type:
 * BRC_SELLER_NOTIFICATION`).
 *
 * Amazon la manda quando l'acquirente vuole annullare un ordine non ancora
 * spedito: è urgente perché ha una scadenza reale, non simbolica — se la
 * logistica evade l'ordine prima che qualcuno lo blocchi, il cliente
 * riceve comunque un prodotto che non vuole più. Verificato su un caso
 * reale (11/09) che senza un riconoscimento dedicato questa email veniva
 * scambiata per la notifica generica di mancata consegna (stesso dominio
 * `amazon.com` del genere 'notifica'), che non apre mai un ticket nuovo —
 * la richiesta restava solo in `ingest_anomaly`, invisibile a chiunque.
 *
 * Stesso schema di `resi.ts`, segnaposto ordine incluso: una richiesta di
 * annullamento può arrivare PRIMA che l'ordine sincronizzi da Shopify (il
 * caso reale che ha rivelato il bug — il cliente cambia idea a ridosso
 * dell'acquisto, prima ancora che il nostro giro periodico lo veda), e
 * senza il segnaposto la richiesta si perderebbe esattamente come sarebbe
 * successo a un reso o un rimborso arrivati troppo presto.
 */

export const TAG_ANNULLAMENTO_RICHIESTO = 'annullamento-richiesto'

/** Il riassunto leggibile che finisce in `message.body_text`: l'agente deve capire subito che va inoltrato alla logistica. */
export function formattaAnnullamento(numeroOrdine: string): string {
  return (
    `Richiesta di annullamento ricevuta da Amazon per l'ordine ${numeroOrdine}: ` +
    `l'acquirente non vuole più il prodotto. Urgente: contattare la logistica ` +
    `per bloccare l'evasione prima della spedizione, se non è già partita.`
  )
}

export interface EsitoAnnullamento {
  esito: 'aperto' | 'aggiornato' | 'gia_visto' | 'orfano'
  thread_id: string | null
}

export async function registraAnnullamento(
  db: Db,
  log: Logger,
  email: EmailGrezza,
  accountId: string,
  orderIdPattern: string | null,
  opzioni: { avviso_sla_minuti: number; giorni_coda: number },
): Promise<EsitoAnnullamento> {
  const numero = estraiNumeroOrdine(email, orderIdPattern)
  if (!numero) {
    await anomalia(db, accountId, 'annullamento_senza_ordine', email)
    return { esito: 'orfano', thread_id: null }
  }

  const arrivato = email.date ?? new Date()
  // Stessa finestra degli avvisi/resi: una richiesta di mesi fa nello
  // storico non deve squillare come una di oggi.
  const vecchio = (Date.now() - arrivato.getTime()) / 86_400_000 > opzioni.giorni_coda
  const scadenza = new Date(arrivato.getTime() + opzioni.avviso_sla_minuti * 60_000)

  return db.begin(async (tx) => {
    // Segnaposto se l'ordine non è ancora in archivio — vedi il caso reale
    // in cima al file. Stesso vincolo unique di upsertOrdine(): quando
    // l'ordine vero arriva da Shopify, ON CONFLICT ne completa i campi
    // senza duplicare né perdere questa riga.
    const [ordine] = await tx<{ id: string; created: boolean }[]>`
      insert into "order" (channel, external_order_id)
      values ('amazon', ${numero})
      on conflict (channel, external_order_id) do update set updated_at = now()
      returning id, (xmax = 0) as created
    `
    const ordineId = ordine!.id
    if (ordine!.created) {
      log.info(
        { ordine: numero },
        'ordine creato come segnaposto: richiesta di annullamento arrivata prima della sincronizzazione da Shopify',
      )
    }

    // Stessa chiave di registraAvviso()/registraReso(): se il cliente
    // scrive di questo ordine, finisce nella STESSA conversazione.
    const chiave = `ordine:${ordineId}`

    const [thread] = await tx<{ id: string; tags: string[]; created: boolean }[]>`
      insert into thread (
        account_id, external_thread_id, order_id, subject, state,
        first_inbound_at, last_inbound_at, due_at, tags
      ) values (
        ${accountId}, ${chiave}, ${ordineId}, ${email.subject},
        ${vecchio ? 'closed' : 'open'}, ${arrivato}, ${arrivato}, ${scadenza},
        ${[TAG_ANNULLAMENTO_RICHIESTO]}
      )
      on conflict (account_id, external_thread_id)
        where external_thread_id is not null
      do update set updated_at = now()
      returning id, tags, (xmax = 0) as created
    `

    const t = thread!
    const gia_visto = !t.created && t.tags.includes(TAG_ANNULLAMENTO_RICHIESTO)

    if (!t.created && !gia_visto) {
      await tx`
        update thread set
          tags       = array_append(tags, ${TAG_ANNULLAMENTO_RICHIESTO}),
          state      = ${vecchio ? tx`state` : tx`'open'`},
          due_at     = least(coalesce(due_at, ${scadenza}), ${scadenza}),
          updated_at = now()
        where id = ${t.id}
      `
    }

    if (!gia_visto) {
      await tx`
        insert into message (
          thread_id, direction, author_kind, external_id, rfc822_id,
          body_text, sent_at, match_strategy, raw
        ) values (
          ${t.id}, 'in', 'system', ${email.rfc822_id}, ${email.rfc822_id},
          ${formattaAnnullamento(numero)}, ${arrivato}, 'numero_ordine',
          ${tx.json(perArchivio(email) as never)}
        )
        on conflict (rfc822_id) where rfc822_id is not null do nothing
      `
    }

    if (!vecchio && !gia_visto) {
      log.warn(
        { thread_id: t.id, ordine: numero },
        'richiesta di annullamento ricevuta: da inoltrare alla logistica',
      )
    }

    return {
      esito: t.created ? ('aperto' as const) : gia_visto ? ('gia_visto' as const) : ('aggiornato' as const),
      thread_id: t.id,
    }
  })
}
