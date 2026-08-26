import nodemailer, { type Transporter } from 'nodemailer'

import type { Config } from '../../config.js'
import type { Db } from '../../db/index.js'
import type { Logger } from '../../logger.js'
import { normalizzaMessageId } from './parse.js'

/**
 * Invio delle risposte via SMTP.
 *
 * Regola che vale più di ogni dettaglio tecnico: la casella che riceve
 * deve essere la stessa identità che risponde, e dev'essere un indirizzo
 * registrato sull'account venditore. Non si divide "ricevo qui, invio da
 * lì": il relay del marketplace rifiuta la risposta e il thread si perde.
 * Per questo il mittente è sempre MAIL_USER e non è configurabile.
 */

export interface RichiestaInvio {
  thread_id: string
  /** Chi ha scritto la risposta: serve solo per l'audit, non per il testo. */
  agent_id: string | null
  testo: string
}

export interface EsitoInvio {
  message_id: string
  rfc822_id: string | null
  destinatario: string
}

let trasporto: Transporter | null = null

export function creaTrasporto(config: Config): Transporter {
  if (trasporto) return trasporto
  if (!config.MAIL_SMTP_HOST || !config.MAIL_USER || !config.MAIL_PASSWORD) {
    throw new Error(
      'SMTP non configurato: servono MAIL_SMTP_HOST, MAIL_USER e MAIL_PASSWORD.',
    )
  }
  trasporto = nodemailer.createTransport({
    host: config.MAIL_SMTP_HOST,
    port: config.MAIL_SMTP_PORT,
    // 465 è TLS implicito, 587 è STARTTLS: la distinzione la fa la porta.
    secure: config.MAIL_SMTP_PORT === 465,
    auth: { user: config.MAIL_USER, pass: config.MAIL_PASSWORD },
  })
  return trasporto
}

export async function inviaRisposta(
  db: Db,
  log: Logger,
  config: Config,
  richiesta: RichiestaInvio,
): Promise<EsitoInvio> {
  // --- A chi rispondiamo, e dentro quale conversazione ------------------
  // Prendiamo l'ultimo messaggio IN ARRIVO del thread: è lui a portare
  // l'indirizzo del relay e gli identificativi che tengono insieme la
  // catena. Rispondere all'ultimo messaggio in uscita non avrebbe senso.
  const [ultimo] = await db<
    {
      subject: string | null
      raw: { from?: string; reply_to?: string; references?: string[] } | null
      rfc822_id: string | null
    }[]
  >`
    select t.subject, m.raw, m.rfc822_id
    from message m
    join thread t on t.id = m.thread_id
    where m.thread_id = ${richiesta.thread_id} and m.direction = 'in'
    order by m.sent_at desc
    limit 1
  `

  if (!ultimo) {
    throw new Error(
      `Il thread ${richiesta.thread_id} non ha messaggi in arrivo: non c'è a chi rispondere.`,
    )
  }

  const destinatario = ultimo.raw?.reply_to ?? ultimo.raw?.from ?? null
  if (!destinatario) {
    throw new Error(
      `Il thread ${richiesta.thread_id} non ha un indirizzo mittente: impossibile rispondere.`,
    )
  }

  const oggetto = ultimo.subject?.toLowerCase().startsWith('re:')
    ? ultimo.subject
    : `Re: ${ultimo.subject ?? ''}`.trim()

  // In-Reply-To e References sono ciò che tiene insieme la conversazione
  // nel client del destinatario. Senza, ogni risposta sembra una email
  // nuova e il cliente perde il filo.
  const references = [...(ultimo.raw?.references ?? []), ultimo.rfc822_id]
    .filter((x): x is string => !!x)
    .map((x) => `<${x}>`)

  const inviato = await creaTrasporto(config).sendMail({
    from: config.MAIL_USER,
    to: destinatario,
    subject: oggetto,
    text: richiesta.testo,
    inReplyTo: ultimo.rfc822_id ? `<${ultimo.rfc822_id}>` : undefined,
    references: references.length > 0 ? references : undefined,
  })

  const rfc822 = normalizzaMessageId(inviato.messageId ?? null)

  // --- Registrazione -----------------------------------------------------
  // Il messaggio in uscita entra nello stesso thread: la conversazione
  // deve leggersi per intero, non a metà.
  const [riga] = await db<{ id: string }[]>`
    insert into message (
      thread_id, direction, author_kind, external_id, rfc822_id,
      in_reply_to, body_text, sent_at, delivery_state, raw
    ) values (
      ${richiesta.thread_id}, 'out', 'agent', ${rfc822}, ${rfc822},
      ${ultimo.rfc822_id}, ${richiesta.testo}, ${new Date()}, 'inviato',
      ${db.json({ to: destinatario, subject: oggetto, accepted: inviato.accepted })}
    )
    returning id
  `

  await db`
    update thread
    set state = 'pending_customer', updated_at = now()
    where id = ${richiesta.thread_id}
  `

  if (richiesta.agent_id) {
    await db`
      insert into audit_log (agent_id, azione, entita, entita_id, dati)
      values (${richiesta.agent_id}, 'risposta_inviata', 'thread',
              ${richiesta.thread_id}, ${db.json({ message_id: riga!.id })})
    `
  }

  // Il destinatario è un alias del relay, non un dato personale, ma per
  // coerenza teniamo fuori dai log tutto ciò che identifica il cliente.
  log.info({ thread_id: richiesta.thread_id }, 'risposta inviata')

  return { message_id: riga!.id, rfc822_id: rfc822, destinatario }
}
