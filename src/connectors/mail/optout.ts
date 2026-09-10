import type { Config } from '../../config.js'
import type { Db } from '../../db/index.js'
import type { Logger } from '../../logger.js'
import { anomalia } from './notifica.js'
import { normalizzaMessageId, perArchivio } from './parse.js'
import { estraiNumeroOrdine } from './riconosci.js'
import { creaTrasporto } from './invia.js'
import type { EmailGrezza } from './tipi.js'

/**
 * L'acquirente ha disattivato i messaggi non richiesti dai venditori
 * (`X-Space-Notification-Type: BUYER_OPTED_OUT_BSM_MESSAGES`).
 *
 * A differenza delle altre notifiche di mancata consegna (genere
 * 'notifica' in notifica.ts, che si limitano ad annotare il thread),
 * Amazon indica qui un rimedio preciso: includere la parola
 * "[Importante]" nell'oggetto fa passare il messaggio anche a un
 * acquirente che ha disattivato i messaggi non essenziali. Verificato su
 * un esemplare reale (09/09) — vedi
 * test/fixtures/mail/amazon-opt-out-reale.eml — non scritto sulla sola
 * indicazione di Amazon nel testo dell'email: il corpo di
 * QUELL'esemplare è la prova che il rimedio funziona così.
 *
 * Un solo tentativo automatico di reinvio per ticket: se anche quello
 * rimbalza, non si ritenta più — a quel punto serve un operatore dal
 * pannello Seller Central (Amazon stessa lo dice: l'alternativa è
 * scrivere dall'interfaccia di messaggistica acquirente-venditore, che
 * non è raggiungibile da qui). Lo stato "già tentato" e "serve
 * l'operatore" vive nei tag del thread, stesso principio di
 * `consegna-fallita` in notifica.ts: nessuna colonna nuova.
 *
 * Non creiamo un ordine/thread segnaposto se non esistono già (a
 * differenza di resi.ts/rimborsi.ts): questa notifica riguarda un NOSTRO
 * messaggio, e se non c'è nessun thread per l'ordine non c'è nessun
 * nostro messaggio da recuperare né da segnalare — stessa scelta di
 * registraNotifica.
 */

export const TAG_REINVIO_TENTATO = 'reinvio-importante-tentato'
export const TAG_RICHIEDE_AZIONE_MANUALE = 'richiede-azione-sellercentral'

export interface EsitoOptOut {
  esito: 'reinviato' | 'richiede_azione_manuale' | 'gia_richiede_azione_manuale' | 'gia_vista' | 'orfano'
  thread_id: string | null
}

/**
 * L'oggetto con cui Amazon fa passare un messaggio anche a un acquirente
 * che ha disattivato quelli non richiesti. Pura: nessuna rete, nessun
 * database — solo la regola scritta nell'email di Amazon.
 */
export function costruisciOggettoImportante(oggettoOriginale: string | null): string {
  const base = (oggettoOriginale ?? '').trim()
  if (/^\[importante\]/i.test(base)) return base
  return base ? `[Importante] ${base}` : '[Importante]'
}

/** Il riassunto leggibile che finisce in `message.body_text` per la notifica in arrivo. */
export function formattaOptOut(
  numeroOrdine: string,
  azione: 'reinviato' | 'richiede_azione_manuale',
): string {
  if (azione === 'reinviato') {
    return (
      `Amazon segnala che l'acquirente dell'ordine ${numeroOrdine} ha disattivato i messaggi ` +
      `non richiesti dai venditori: il nostro ultimo messaggio non è stato consegnato. ` +
      `Reinviato una volta con "[Importante]" nell'oggetto, come indicato da Amazon.`
    )
  }
  return (
    `Amazon segnala che l'acquirente dell'ordine ${numeroOrdine} ha disattivato i messaggi ` +
    `non richiesti dai venditori e il messaggio non è stato consegnato. Serve un intervento ` +
    `manuale dal pannello Seller Central (servizio messaggi acquirente-venditore).`
  )
}

export async function registraOptOut(
  db: Db,
  log: Logger,
  config: Config,
  email: EmailGrezza,
  accountId: string,
  orderIdPattern: string | null,
): Promise<EsitoOptOut> {
  const numero = estraiNumeroOrdine(email, orderIdPattern)
  if (!numero) {
    await anomalia(db, accountId, 'opt_out_senza_ordine', email)
    return { esito: 'orfano', thread_id: null }
  }

  const [thread] = await db<{ id: string; tags: string[] }[]>`
    select t.id, t.tags
    from thread t
    join "order" o on o.id = t.order_id
    where o.external_order_id = ${numero}
    order by t.last_inbound_at desc nulls last
    limit 1
  `
  if (!thread) {
    await anomalia(db, accountId, 'opt_out_ordine_sconosciuto', email, numero)
    return { esito: 'orfano', thread_id: null }
  }

  // Dedup sulla notifica IN SÉ, non solo sui tag: una rilettura IMAP della
  // STESSA email non deve contarsi come un secondo, vero, fallimento del
  // reinvio — altrimenti una semplice ripetizione del giro escalerebbe
  // ad azione manuale senza che sia successo nulla di nuovo.
  if (email.rfc822_id) {
    const [visto] = await db<{ id: string }[]>`
      select id from message where rfc822_id = ${email.rfc822_id} limit 1
    `
    if (visto) return { esito: 'gia_vista', thread_id: thread.id }
  }

  const giaManuale = thread.tags.includes(TAG_RICHIEDE_AZIONE_MANUALE)
  const giaTentato = thread.tags.includes(TAG_REINVIO_TENTATO)

  let azione: 'reinviato' | 'richiede_azione_manuale' = 'richiede_azione_manuale'
  let inviato: { rfc822: string | null; destinatario: string; oggetto: string; testo: string } | null = null

  if (!giaManuale && !giaTentato) {
    type RigaOut = {
      id: string
      body_text: string | null
      rfc822_id: string | null
      raw: { to?: string; subject?: string } | null
    }
    const [ultimoOut] = await db<RigaOut[]>`
      select id, body_text, rfc822_id, raw
      from message
      where thread_id = ${thread.id} and direction = 'out'
      order by sent_at desc
      limit 1
    `

    const destinatario = ultimoOut?.raw?.to ?? null
    if (ultimoOut?.body_text && destinatario) {
      const oggetto = costruisciOggettoImportante(ultimoOut.raw?.subject ?? null)
      try {
        // Spedizione via SMTP prima di aprire la transazione: è I/O di
        // rete, stessa regola già scritta in upsert.ts/collega.ts.
        const risultatoInvio = await creaTrasporto(config).sendMail({
          from: config.MAIL_USER,
          to: destinatario,
          subject: oggetto,
          text: ultimoOut.body_text,
          inReplyTo: ultimoOut.rfc822_id ? `<${ultimoOut.rfc822_id}>` : undefined,
        })
        azione = 'reinviato'
        inviato = {
          rfc822: normalizzaMessageId(risultatoInvio.messageId ?? null),
          destinatario,
          oggetto,
          testo: ultimoOut.body_text,
        }
        await db`
          update message set delivery_state = 'non_consegnato', updated_at = now()
          where id = ${ultimoOut.id}
        `
      } catch (errore) {
        log.error(
          { thread_id: thread.id, ordine: numero, err: errore instanceof Error ? errore.message : String(errore) },
          'reinvio con [Importante] fallito: serve intervento manuale da Seller Central',
        )
      }
    }
  }

  return db.begin(async (tx) => {
    // La notifica in arrivo entra sempre nel thread, con un riassunto
    // leggibile: l'agente deve vedere PERCHÉ il ticket è tornato aperto.
    await tx`
      insert into message (
        thread_id, direction, author_kind, external_id, rfc822_id,
        body_text, sent_at, match_strategy, raw
      ) values (
        ${thread.id}, 'in', 'system', ${email.rfc822_id}, ${email.rfc822_id},
        ${formattaOptOut(numero, azione)}, ${email.date ?? new Date()}, 'numero_ordine',
        ${tx.json(perArchivio(email) as never)}
      )
      on conflict (rfc822_id) where rfc822_id is not null do nothing
    `

    if (azione === 'reinviato' && inviato) {
      await tx`
        insert into message (
          thread_id, direction, author_kind, agent_id, external_id, rfc822_id,
          body_text, sent_at, delivery_state, raw
        ) values (
          ${thread.id}, 'out', 'agent', null, ${inviato.rfc822}, ${inviato.rfc822},
          ${inviato.testo}, now(), 'inviato',
          ${tx.json({ to: inviato.destinatario, subject: inviato.oggetto })}
        )
      `
      await tx`
        update thread set
          tags       = array_append(tags, ${TAG_REINVIO_TENTATO}),
          state      = case when state = 'closed' then 'open' else state end,
          updated_at = now()
        where id = ${thread.id}
      `
      log.warn(
        { thread_id: thread.id, ordine: numero },
        'acquirente ha disattivato i messaggi: reinviato con [Importante] nell\'oggetto',
      )
      return { esito: 'reinviato' as const, thread_id: thread.id }
    }

    if (giaManuale) {
      // Serve già un intervento manuale: solo riaprire, il tag c'è già.
      await tx`
        update thread set
          state      = case when state = 'closed' then 'open' else state end,
          updated_at = now()
        where id = ${thread.id}
      `
      return { esito: 'gia_richiede_azione_manuale' as const, thread_id: thread.id }
    }

    await tx`
      update thread set
        tags       = array_append(tags, ${TAG_RICHIEDE_AZIONE_MANUALE}),
        state      = case when state = 'closed' then 'open' else state end,
        updated_at = now()
      where id = ${thread.id}
    `
    log.warn(
      { thread_id: thread.id, ordine: numero, gia_tentato: giaTentato },
      'acquirente ha disattivato i messaggi: serve intervento manuale da Seller Central',
    )
    return { esito: 'richiede_azione_manuale' as const, thread_id: thread.id }
  })
}
