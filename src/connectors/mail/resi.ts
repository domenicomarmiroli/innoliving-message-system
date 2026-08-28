import type { Db } from '../../db/index.js'
import type { Logger } from '../../logger.js'
import { anomalia } from './notifica.js'
import { perArchivio } from './parse.js'
import { estraiNumeroOrdine } from './riconosci.js'
import type { EmailGrezza } from './tipi.js'

/**
 * Richieste di reso autorizzate da Amazon (`X-Space-Notification-Type:
 * RETURN_REQUEST`).
 *
 * Non le scrive il cliente — arriva da Amazon, come gli avvisi A-to-Z —
 * ma è un'informazione che serve a chi lavora quell'ordine: che è stata
 * aperta una richiesta di reso, perché, e se Amazon ha già emesso
 * un'etichetta di spedizione per il rientro (corriere e tracking, che
 * l'agente deve vedere senza andare a cercarli nella email originale).
 *
 * Stesso schema di `registraAvviso`: si aggancia alla conversazione
 * dell'ordine, la apre se non c'è. Verificato su un'email reale — vedi
 * test/fixtures/mail/amazon-richiesta-reso-reale.eml — non scritto sulla
 * documentazione: qui la documentazione pubblica di Amazon non esiste
 * nemmeno, il formato si impara solo da un esemplare vero.
 */

export const TAG_RESO_RICHIESTO = 'reso-richiesto'

export interface RigaReso {
  prodotto: string | null
  asin: string | null
  sku: string | null
  quantita: string | null
  motivo: string | null
  commento: string | null
}

export interface DatiReso {
  data_richiesta: string | null
  verifica_politiche: string | null
  autorizzazione: string | null
  righe: RigaReso[]
  corriere_reso: string | null
  tracking_reso: string | null
}

/** Toglie i tag, normalizza gli spazi, decodifica le poche entità HTML che contano. */
function testoPulito(html: string): string {
  return html
    .replace(/<[^>]+>/g, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

/** Un campo scritto come `<b>Etichetta:</b> valore` nella lista riassuntiva. */
function campoEtichettaGrassetto(html: string, etichetta: string): string | null {
  const escaped = etichetta.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const re = new RegExp(`<b>\\s*${escaped}\\s*<\\/b>\\s*([^<]+)`, 'i')
  const trovato = html.match(re)
  return trovato?.[1] ? testoPulito(trovato[1]) : null
}

/** Un campo scritto come testo semplice `Etichetta: valore` (lista tracciamento). */
function campoEtichettaSemplice(html: string, etichetta: string): string | null {
  const escaped = etichetta.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const re = new RegExp(`${escaped}\\s*:\\s*([^<]+)`, 'i')
  const trovato = html.match(re)
  return trovato?.[1] ? testoPulito(trovato[1]) : null
}

/**
 * La tabella degli articoli da restituire. Riconosciuta da
 * `cellpadding="10"`: non elegante, ma è l'unico marcatore stabile senza
 * un secondo esemplare che confermi se cambia da un reso all'altro.
 * Tollerante: una tabella diversa da quella attesa produce un elenco
 * vuoto, non un'eccezione — l'email resta comunque in `raw`.
 */
function estraiRighe(html: string): RigaReso[] {
  const tabella = html.match(/<table[^>]*cellpadding="10"[^>]*>([\s\S]*?)<\/table>/i)
  if (!tabella?.[1]) return []

  const righe: RigaReso[] = []
  for (const rigaMatch of tabella[1].matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/gi)) {
    const rigaHtml = rigaMatch[1] ?? ''
    if (/<th[\s>]/i.test(rigaHtml)) continue // riga di intestazione

    const celle = [...rigaHtml.matchAll(/<td[^>]*>([\s\S]*?)<\/td>/gi)].map((m) =>
      testoPulito(m[1] ?? ''),
    )
    if (celle.length === 0) continue

    righe.push({
      prodotto: celle[0] || null,
      asin: celle[1] || null,
      sku: celle[2] || null,
      quantita: celle[3] || null,
      motivo: celle[4] || null,
      commento: celle[5] || null,
    })
  }
  return righe
}

export function estraiDatiReso(html: string | null): DatiReso {
  if (!html) {
    return {
      data_richiesta: null,
      verifica_politiche: null,
      autorizzazione: null,
      righe: [],
      corriere_reso: null,
      tracking_reso: null,
    }
  }
  return {
    data_richiesta: campoEtichettaGrassetto(html, 'Data della richiesta di reso:'),
    verifica_politiche: campoEtichettaGrassetto(html, 'Verifica delle politiche di reso:'),
    autorizzazione: campoEtichettaGrassetto(html, 'Autorizzazione:'),
    righe: estraiRighe(html),
    corriere_reso: campoEtichettaSemplice(html, 'Corriere spedizione di reso'),
    tracking_reso: campoEtichettaSemplice(html, 'Numero di tracciamento'),
  }
}

/** Il riassunto leggibile che finisce in `message.body_text`: l'agente lo legge in coda, non l'HTML. */
export function formattaReso(numeroOrdine: string, dati: DatiReso): string {
  const righe: string[] = [`Richiesta di reso ricevuta da Amazon per l'ordine ${numeroOrdine}.`]
  if (dati.data_richiesta) righe.push(`Data della richiesta: ${dati.data_richiesta}`)
  if (dati.verifica_politiche) righe.push(`Verifica politiche: ${dati.verifica_politiche}`)
  if (dati.autorizzazione) righe.push(`Autorizzazione: ${dati.autorizzazione}`)

  for (const r of dati.righe) {
    const dettagli = [
      r.sku ? `SKU ${r.sku}` : null,
      r.quantita ? `quantità ${r.quantita}` : null,
      r.motivo ? `motivo: ${r.motivo}` : null,
    ]
      .filter(Boolean)
      .join(', ')
    righe.push(`- ${r.prodotto ?? 'Articolo'}${dettagli ? ` (${dettagli})` : ''}`)
    if (r.commento) righe.push(`  Commento del cliente: ${r.commento}`)
  }

  if (dati.corriere_reso || dati.tracking_reso) {
    righe.push(
      `Spedizione di reso: ${dati.corriere_reso ?? 'corriere non indicato'}` +
        (dati.tracking_reso ? `, tracking ${dati.tracking_reso}` : ''),
    )
  }

  return righe.join('\n')
}

export interface EsitoReso {
  esito: 'aperto' | 'aggiornato' | 'gia_visto' | 'orfano'
  thread_id: string | null
}

export async function registraReso(
  db: Db,
  log: Logger,
  email: EmailGrezza,
  accountId: string,
  orderIdPattern: string | null,
  opzioni: { avviso_sla_minuti: number; giorni_coda: number },
): Promise<EsitoReso> {
  const numero = estraiNumeroOrdine(email, orderIdPattern)
  if (!numero) {
    await anomalia(db, accountId, 'reso_senza_ordine', email)
    return { esito: 'orfano', thread_id: null }
  }

  const dati = estraiDatiReso(email.body_html)
  const arrivato = email.date ?? new Date()
  // Stessa finestra degli avvisi: un reso di mesi fa nello storico non
  // deve far squillare l'allarme come uno di oggi.
  const vecchio = (Date.now() - arrivato.getTime()) / 86_400_000 > opzioni.giorni_coda
  const scadenza = new Date(arrivato.getTime() + opzioni.avviso_sla_minuti * 60_000)

  return db.begin(async (tx) => {
    const [ordine] = await tx<{ id: string }[]>`
      select id from "order" where external_order_id = ${numero} limit 1
    `
    // Come per gli avvisi: se l'ordine non è (ancora) in archivio, la
    // richiesta finisce in ingest_anomaly e non in coda — stesso limite
    // già noto (ordini Amazon non sincronizzati), non specifico dei resi.
    if (!ordine) {
      await anomalia(db, accountId, 'reso_ordine_sconosciuto', email, numero)
      return { esito: 'orfano' as const, thread_id: null }
    }

    if (dati.corriere_reso || dati.tracking_reso) {
      await tx`
        update "order" set
          reso_carrier         = coalesce(${dati.corriere_reso}, reso_carrier),
          reso_tracking_number = coalesce(${dati.tracking_reso}, reso_tracking_number),
          updated_at            = now()
        where id = ${ordine.id}
      `
    }

    // Stessa chiave di registraAvviso: se il cliente scrive di questo
    // ordine, finisce nella stessa conversazione, non in una parallela.
    const chiave = `ordine:${ordine.id}`

    const [thread] = await tx<{ id: string; tags: string[]; created: boolean }[]>`
      insert into thread (
        account_id, external_thread_id, order_id, subject, state,
        first_inbound_at, last_inbound_at, due_at, tags
      ) values (
        ${accountId}, ${chiave}, ${ordine.id}, ${email.subject},
        ${vecchio ? 'closed' : 'open'}, ${arrivato}, ${arrivato}, ${scadenza},
        ${[TAG_RESO_RICHIESTO]}
      )
      on conflict (account_id, external_thread_id)
        where external_thread_id is not null
      do update set updated_at = now()
      returning id, tags, (xmax = 0) as created
    `

    const t = thread!
    const gia_visto = !t.created && t.tags.includes(TAG_RESO_RICHIESTO)

    if (!t.created && !gia_visto) {
      await tx`
        update thread set
          tags       = array_append(tags, ${TAG_RESO_RICHIESTO}),
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
          ${formattaReso(numero, dati)}, ${arrivato}, 'numero_ordine',
          ${tx.json(perArchivio(email) as never)}
        )
        on conflict (rfc822_id) where rfc822_id is not null do nothing
      `
    }

    if (!vecchio && !gia_visto) {
      log.warn({ thread_id: t.id, ordine: numero }, 'richiesta di reso ricevuta')
    }

    return {
      esito: gia_visto ? ('gia_visto' as const) : t.created ? ('aperto' as const) : ('aggiornato' as const),
      thread_id: t.id,
    }
  })
}
