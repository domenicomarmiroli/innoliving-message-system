import nodemailer, { type Transporter } from 'nodemailer'
import sharp from 'sharp'

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
 * Limite di Graph per `sendMail` con MIME in una sola richiesta: 4 MB
 * **sul corpo della richiesta**, cioè sul MIME già codificato in base64
 * (un terzo più grande del MIME stesso, che a sua volta contiene gli
 * allegati codificati in base64). In pratica restano circa 2 MB di
 * allegati veri. Oltre servirebbe una upload session; prima di arrivare
 * qui `adattaAllegatiAlTrasporto()` riduce le immagini, e se nemmeno
 * così basta l'errore deve essere leggibile, non un 413 grezzo.
 */
const LIMITE_RICHIESTA_GRAPH = 4 * 1024 * 1024

/**
 * Quanti byte di allegati far entrare in un'email Graph: il limite sopra
 * diviso due volte per l'espansione del base64, con un margine per
 * intestazioni e testo.
 */
const BUDGET_ALLEGATI_GRAPH = Math.floor((LIMITE_RICHIESTA_GRAPH / 1.37 / 1.37) * 0.9)

/** Passi di riduzione: lato lungo in pixel e qualità JPEG, dal più leggero al più deciso. */
const PASSI_RIDUZIONE: Array<{ lato: number; qualita: number }> = [
  { lato: 2048, qualita: 82 },
  { lato: 1600, qualita: 76 },
  { lato: 1280, qualita: 70 },
  { lato: 1024, qualita: 65 },
]

const IMMAGINI_RIDUCIBILI = new Set([
  'image/jpeg',
  'image/jpg',
  'image/png',
  'image/webp',
  'image/tiff',
  'image/bmp',
])

function totaleByte(allegati: FilePronto[]): number {
  return allegati.reduce((n, a) => n + a.contenuto.byteLength, 0)
}

/**
 * Adatta gli allegati al limite del trasporto, **prima** di spedire e
 * prima di registrarli: chi chiama usa il risultato per entrambe le cose,
 * così in cronologia resta il file davvero partito (stessa regola di
 * `core/attachments/normalize.ts`), non quello scelto in origine.
 *
 * Su SMTP (Gmail, 25 MB) non tocca niente. Su Graph, solo se la somma
 * supera il budget, riduce le immagini più grandi una alla volta,
 * passando a passi sempre più decisi, finché non ci stanno: quattro foto
 * da telefono per un corriere non hanno bisogno di 12 megapixel, ma non
 * si riducono se non serve. I PDF e gli altri file non si toccano. Se
 * nemmeno così il totale rientra, lancia con un messaggio che dice
 * quanto pesa e cosa fare.
 */
export async function adattaAllegatiAlTrasporto(
  trasporto: Trasporto,
  allegati: FilePronto[],
): Promise<FilePronto[]> {
  if (trasporto !== 'graph' || totaleByte(allegati) <= BUDGET_ALLEGATI_GRAPH) return allegati

  const risultato = [...allegati]
  for (const passo of PASSI_RIDUZIONE) {
    // Le immagini più pesanti per prime: sono quelle che fanno la differenza.
    const ordine = risultato
      .map((a, i) => ({ a, i }))
      .filter(({ a }) => IMMAGINI_RIDUCIBILI.has(a.mime))
      .sort((x, y) => y.a.contenuto.byteLength - x.a.contenuto.byteLength)

    for (const { a, i } of ordine) {
      if (totaleByte(risultato) <= BUDGET_ALLEGATI_GRAPH) return risultato
      risultato[i] = await riduciImmagine(a, passo.lato, passo.qualita)
    }
    if (totaleByte(risultato) <= BUDGET_ALLEGATI_GRAPH) return risultato
  }

  const mb = (n: number) => (n / 1024 / 1024).toFixed(1)
  throw new Error(
    `Gli allegati pesano ${mb(totaleByte(risultato))} MB anche dopo aver ridotto le immagini, ` +
      `oltre il limite di circa ${mb(BUDGET_ALLEGATI_GRAPH)} MB per un'email dalla casella Microsoft: ` +
      'togline qualcuno o mandali in più messaggi.',
  )
}

async function riduciImmagine(a: FilePronto, lato: number, qualita: number): Promise<FilePronto> {
  const ridotta = await sharp(a.contenuto)
    .rotate() // rispetta l'orientamento EXIF delle foto da telefono
    .resize({ width: lato, height: lato, fit: 'inside', withoutEnlargement: true })
    .jpeg({ quality: qualita, mozjpeg: true })
    .toBuffer()
  // Se per qualche motivo la versione "ridotta" pesa di più, si tiene l'originale.
  if (ridotta.byteLength >= a.contenuto.byteLength) return a
  return {
    nome_file: a.nome_file.replace(/\.[^.]+$/, '') + '.jpg',
    mime: 'image/jpeg',
    contenuto: ridotta,
    convertito_da: a.convertito_da ?? a.mime,
    note: [...a.note, `Ridotta a ${lato}px per il limite di dimensione della casella Microsoft.`],
  }
}

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

  // `sendMail` con MIME vuole il messaggio codificato in base64 e
  // `Content-Type: text/plain`. Sembra strano ed è documentato così. Il
  // limite vale su questo corpo, non sul MIME grezzo.
  const corpo = mime.toString('base64')
  if (corpo.length > LIMITE_RICHIESTA_GRAPH) {
    throw new Error(
      `Messaggio troppo grande per la casella Microsoft (${(corpo.length / 1024 / 1024).toFixed(1)} MB ` +
        `codificato, limite ${LIMITE_RICHIESTA_GRAPH / 1024 / 1024} MB): riduci gli allegati.`,
    )
  }

  const client = new ClientGraph(config, log)
  await client.post(`/users/${encodeURIComponent(client.casella)}/sendMail`, corpo, 'text/plain')

  return { rfc822_id, accettati: [sp.a] }
}
