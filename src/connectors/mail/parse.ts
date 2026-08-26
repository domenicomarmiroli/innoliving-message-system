import { createHash } from 'node:crypto'
import { simpleParser, type AddressObject } from 'mailparser'

import type { AllegatoGrezzo, EmailGrezza } from './tipi.js'

/**
 * Da sorgente RFC822 a EmailGrezza.
 *
 * Non interpreta niente: estrae le intestazioni e i corpi così come sono.
 * Ogni giudizio su canale, ordine e cliente avviene dopo, altrove.
 */

/** Appiattisce i molti modi in cui mailparser rappresenta un indirizzo. */
function indirizzi(campo: AddressObject | AddressObject[] | undefined): string[] {
  if (!campo) return []
  const lista = Array.isArray(campo) ? campo : [campo]
  return lista.flatMap((a) => a.value.map((v) => v.address ?? '').filter(Boolean))
}

export async function analizza(sorgente: Buffer, uid: number | null): Promise<EmailGrezza> {
  const m = await simpleParser(sorgente, {
    // Non ci serve il testo con le citazioni separate, e costa.
    skipTextLinks: true,
  })

  const allegati: AllegatoGrezzo[] = (m.attachments ?? []).map((a) => ({
    nome_file: a.filename ?? null,
    mime: a.contentType ?? null,
    dimensione_byte: a.size ?? a.content?.length ?? 0,
    checksum: createHash('sha256').update(a.content ?? Buffer.alloc(0)).digest('hex'),
    contenuto: a.content ?? Buffer.alloc(0),
  }))

  return {
    rfc822_id: normalizzaMessageId(m.messageId ?? null),
    in_reply_to: normalizzaMessageId(m.inReplyTo ?? null),
    references: referencesDi(m.references),
    from: indirizzi(m.from)[0] ?? null,
    reply_to: indirizzi(m.replyTo)[0] ?? null,
    to: indirizzi(m.to),
    subject: m.subject ?? null,
    date: m.date ?? null,
    body_text: m.text ?? null,
    body_html: typeof m.html === 'string' ? m.html : null,
    allegati,
    uid,
  }
}

/**
 * Un Message-ID va confrontato senza le parentesi angolari e senza spazi:
 * server diversi le scrivono in modo diverso, e il vincolo unique in
 * database deve vedere la stessa stringa per la stessa email.
 */
export function normalizzaMessageId(id: string | null): string | null {
  if (!id) return null
  const pulito = id.trim().replace(/^</, '').replace(/>$/, '').trim()
  return pulito.length > 0 ? pulito : null
}

function referencesDi(ref: string | string[] | undefined): string[] {
  if (!ref) return []
  const lista = Array.isArray(ref) ? ref : ref.split(/\s+/)
  return lista
    .map((r) => normalizzaMessageId(r))
    .filter((r): r is string => r !== null)
}

/**
 * Cosa conserviamo in message.raw.
 *
 * Le intestazioni e i corpi, non i byte degli allegati: quelli
 * gonfierebbero il database senza aggiungere nulla che il checksum e lo
 * storage non diano meglio. Il resto resta integrale, perché quando
 * scopriremo che un parser sbagliava riprocesseremo da qui (regola 4).
 */
export function perArchivio(email: EmailGrezza): Record<string, unknown> {
  return {
    rfc822_id: email.rfc822_id,
    in_reply_to: email.in_reply_to,
    references: email.references,
    from: email.from,
    reply_to: email.reply_to,
    to: email.to,
    subject: email.subject,
    date: email.date?.toISOString() ?? null,
    body_text: email.body_text,
    body_html: email.body_html,
    // Mai il campo `contenuto`: i byte degli allegati vanno solo su
    // Storage, non nel JSONB — gonfierebbero il database senza motivo.
    allegati: email.allegati.map(({ contenuto: _contenuto, ...resto }) => resto),
    uid: email.uid,
  }
}
