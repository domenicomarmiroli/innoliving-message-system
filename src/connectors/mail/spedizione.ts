import nodemailer, { type Transporter } from 'nodemailer'

import type { Config } from '../../config.js'
import type { Logger } from '../../logger.js'
import type { FilePronto } from '../../core/attachments/normalize.js'
import { ClientGraph } from '../graph/client.js'
import type { Trasporto } from './casella.js'
import { normalizzaMessageId } from './parse.js'

/**
 * Un solo punto di uscita per la posta, due trasporti dietro.
 *
 * Regola che vale più di ogni dettaglio tecnico, e non cambia con
 * Microsoft: **la casella che riceve deve essere la stessa identità che
 * risponde.** Non si divide "ricevo qui, rispondo da lì" — il relay del
 * marketplace rifiuta la risposta e il thread si perde. Per questo il
 * mittente non è un parametro libero: lo decide il trasporto, cioè la
 * casella da cui il ticket è entrato.
 *
 * Il MIME lo compone nodemailer in entrambi i casi. Su SMTP lo spedisce
 * anche; su Graph lo costruisce soltanto e i byte li consegna
 * `sendMail`. Il motivo è In-Reply-To/References: i campi JSON di Graph
 * non permettono di impostarli (accetta solo header `x-*`
 * personalizzati), e senza quelli ogni risposta sembra una email nuova
 * e il cliente perde il filo. Con il MIME grezzo li controlliamo noi,
 * esattamente come su SMTP.
 */

export interface Spedizione {
  a: string
  oggetto: string
  testo: string
  inReplyTo?: string | null
  references?: string[]
  allegati?: FilePronto[]
}

export interface EsitoSpedizione {
  /** Message-ID normalizzato (senza parentesi angolari), o null se non ricavabile. */
  rfc822_id: string | null
  /** Solo SMTP lo sa davvero; su Graph è il destinatario richiesto. */
  accettati: string[]
}

/**
 * Limite di Graph per `sendMail` con MIME in una sola richiesta. Oltre
 * servirebbe una upload session; con gli allegati già normalizzati a
 * 4 MB da `core/attachments` non ci arriviamo, ma se succede è meglio
 * un errore leggibile di un 413 grezzo.
 */
const LIMITE_MIME_GRAPH = 4 * 1024 * 1024

let trasportoSmtp: Transporter | null = null

export function creaTrasporto(config: Config): Transporter {
  if (trasportoSmtp) return trasportoSmtp
  if (!config.MAIL_SMTP_HOST || !config.MAIL_USER || !config.MAIL_PASSWORD) {
    throw new Error('SMTP non configurato: servono MAIL_SMTP_HOST, MAIL_USER e MAIL_PASSWORD.')
  }
  trasportoSmtp = nodemailer.createTransport({
    host: config.MAIL_SMTP_HOST,
    port: config.MAIL_SMTP_PORT,
    // 465 è TLS implicito, 587 è STARTTLS: la distinzione la fa la porta.
    secure: config.MAIL_SMTP_PORT === 465,
    auth: { user: config.MAIL_USER, pass: config.MAIL_PASSWORD },
  })
  return trasportoSmtp
}

/** L'indirizzo da cui parte la posta di un trasporto. */
export function mittenteDi(config: Config, trasporto: Trasporto): string {
  const da = trasporto === 'graph' ? config.MS_MAILBOX : config.MAIL_USER
  if (!da) {
    throw new Error(
      trasporto === 'graph'
        ? 'MS_MAILBOX non impostata: non so da quale casella Microsoft rispondere.'
        : 'MAIL_USER non impostata: non so da quale casella rispondere.',
    )
  }
  return da
}

function messaggio(da: string, sp: Spedizione) {
  return {
    from: da,
    to: sp.a,
    subject: sp.oggetto,
    text: sp.testo,
    inReplyTo: sp.inReplyTo ? `<${sp.inReplyTo}>` : undefined,
    references: sp.references && sp.references.length > 0 ? sp.references : undefined,
    attachments: sp.allegati?.map((a) => ({
      filename: a.nome_file,
      content: a.contenuto,
      contentType: a.mime,
    })),
  }
}

/**
 * Compone il MIME senza spedirlo. `streamTransport` con `buffer: true`
 * è il modo previsto da nodemailer per usarlo come sola libreria di
 * composizione: genera anche il Message-ID, che ci serve per registrare
 * il messaggio e per la catena delle risposte future.
 */
export async function componiMime(
  config: Config,
  trasporto: Trasporto,
  sp: Spedizione,
): Promise<{ mime: Buffer; rfc822_id: string | null }> {
  const compositore = nodemailer.createTransport({
    streamTransport: true,
    buffer: true,
    newline: 'windows',
  })
  const esito = await compositore.sendMail(messaggio(mittenteDi(config, trasporto), sp))
  return {
    mime: esito.message as Buffer,
    rfc822_id: normalizzaMessageId(esito.messageId ?? null),
  }
}

export async function spedisci(
  config: Config,
  log: Logger,
  trasporto: Trasporto,
  sp: Spedizione,
): Promise<EsitoSpedizione> {
  if (trasporto === 'graph') return spedisciGraph(config, log, sp)

  const inviato = await creaTrasporto(config).sendMail(messaggio(mittenteDi(config, 'imap'), sp))
  return {
    rfc822_id: normalizzaMessageId(inviato.messageId ?? null),
    accettati: ((inviato.accepted ?? []) as unknown[]).map((x) => String(x)),
  }
}

async function spedisciGraph(
  config: Config,
  log: Logger,
  sp: Spedizione,
): Promise<EsitoSpedizione> {
  const { mime, rfc822_id } = await componiMime(config, 'graph', sp)

  if (mime.byteLength > LIMITE_MIME_GRAPH) {
    throw new Error(
      `Messaggio troppo grande per Graph (${Math.round(mime.byteLength / 1024)} KB, limite ` +
        `${LIMITE_MIME_GRAPH / 1024 / 1024} MB): riduci gli allegati.`,
    )
  }

  const client = new ClientGraph(config, log)
  // `sendMail` con MIME vuole il messaggio codificato in base64 e
  // `Content-Type: text/plain`. Sembra strano ed è documentato così.
  await client.post(
    `/users/${encodeURIComponent(client.casella)}/sendMail`,
    mime.toString('base64'),
    'text/plain',
  )

  return { rfc822_id, accettati: [sp.a] }
}
