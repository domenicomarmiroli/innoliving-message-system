import type { Db } from '../../db/index.js'
import type { Logger } from '../../logger.js'
import { campoEtichettaGrassetto, estraiRigheTabella } from './html.js'
import { anomalia } from './notifica.js'
import { perArchivio } from './parse.js'
import { estraiNumeroOrdine } from './riconosci.js'
import type { EmailGrezza } from './tipi.js'

/**
 * Rimborsi emessi da Amazon (`X-Space-Notification-Type: REFUND_ISSUED`).
 *
 * A differenza di un reso, un rimborso può succedere più volte sullo
 * stesso ordine — un rimborso parziale su un articolo, poi un altro su
 * un secondo articolo, in email diverse. Per questo qui NON si salta
 * l'elaborazione in base a un tag già presente sul thread (come fa
 * `resi.ts`, dove "reso richiesto" è un evento che ha senso solo una
 * volta): l'unica difesa contro il duplicato è il vincolo unique su
 * `rfc822_id` — la stessa identica email non conta due volte, ma due
 * email di rimborso diverse per lo stesso ordine sommano entrambe.
 *
 * Verificato su un'email reale — vedi
 * test/fixtures/mail/amazon-rimborso-emesso-reale.eml — stessa
 * impaginazione a lista + tabella dei resi, stesso motivo per non fidarsi
 * della sola documentazione (qui non esiste nemmeno).
 */

export const TAG_RIMBORSO_EMESSO = 'rimborso-emesso'

export interface RigaRimborso {
  prodotto: string | null
  asin: string | null
  sku: string | null
  quantita: string | null
  rimborso_prezzo: string | null
  rimborso_spedizione: string | null
  motivo: string | null
}

export interface DatiRimborso {
  importo_totale: number | null
  valuta: string | null
  rete_logistica: string | null
  righe: RigaRimborso[]
}

function estraiRighe(html: string): RigaRimborso[] {
  return estraiRigheTabella(html).map((celle) => ({
    prodotto: celle[0] || null,
    asin: celle[1] || null,
    sku: celle[2] || null,
    quantita: celle[3] || null,
    rimborso_prezzo: celle[4] || null,
    rimborso_spedizione: celle[5] || null,
    motivo: celle[6] || null,
  }))
}

/**
 * Importo e valuta dalla frase riassuntiva ("abbiamo avviato un rimborso
 * di EUR 169.01 a <nome cliente> per i seguenti articoli"). Non c'è un
 * campo strutturato per questo: è testo libero, quindi tollerante — se
 * la frase cambia forma, importo e valuta restano null invece di far
 * fallire tutto il resto dell'estrazione.
 */
function estraiImporto(html: string): { importo_totale: number | null; valuta: string | null } {
  const trovato = html.match(/rimborso di\s+([A-Za-z]{3})\s*([\d.,]+)/i)
  if (!trovato) return { importo_totale: null, valuta: null }
  const numero = Number(trovato[2]!.replace(/,/g, ''))
  return {
    valuta: trovato[1]!.toUpperCase(),
    importo_totale: Number.isFinite(numero) ? numero : null,
  }
}

export function estraiDatiRimborso(html: string | null): DatiRimborso {
  if (!html) return { importo_totale: null, valuta: null, rete_logistica: null, righe: [] }
  return {
    ...estraiImporto(html),
    rete_logistica: campoEtichettaGrassetto(html, 'Rete logistica di Amazon:'),
    righe: estraiRighe(html),
  }
}

/** Il riassunto leggibile che finisce in `message.body_text`. */
export function formattaRimborso(numeroOrdine: string, dati: DatiRimborso): string {
  const righe: string[] = [`Rimborso emesso da Amazon per l'ordine ${numeroOrdine}.`]
  if (dati.importo_totale !== null) {
    righe.push(`Importo: ${dati.valuta ?? ''} ${dati.importo_totale}`.trim())
  }
  if (dati.rete_logistica) righe.push(`Rete logistica: ${dati.rete_logistica}`)

  for (const r of dati.righe) {
    const dettagli = [
      r.sku ? `SKU ${r.sku}` : null,
      r.quantita ? `quantità ${r.quantita}` : null,
      r.rimborso_prezzo ? `prezzo ${r.rimborso_prezzo}` : null,
      r.rimborso_spedizione ? `spedizione ${r.rimborso_spedizione}` : null,
    ]
      .filter(Boolean)
      .join(', ')
    righe.push(`- ${r.prodotto ?? 'Articolo'}${dettagli ? ` (${dettagli})` : ''}`)
    if (r.motivo) righe.push(`  Motivo: ${r.motivo}`)
  }

  return righe.join('\n')
}

export interface EsitoRimborso {
  esito: 'registrato' | 'gia_visto' | 'orfano'
  thread_id: string | null
}

export async function registraRimborso(
  db: Db,
  log: Logger,
  email: EmailGrezza,
  accountId: string,
  orderIdPattern: string | null,
  opzioni: { avviso_sla_minuti: number; giorni_coda: number },
): Promise<EsitoRimborso> {
  const numero = estraiNumeroOrdine(email, orderIdPattern)
  if (!numero) {
    await anomalia(db, accountId, 'rimborso_senza_ordine', email)
    return { esito: 'orfano', thread_id: null }
  }

  const dati = estraiDatiRimborso(email.body_html)
  const arrivato = email.date ?? new Date()
  const vecchio = (Date.now() - arrivato.getTime()) / 86_400_000 > opzioni.giorni_coda
  const scadenza = new Date(arrivato.getTime() + opzioni.avviso_sla_minuti * 60_000)

  return db.begin(async (tx) => {
    const [ordine] = await tx<{ id: string }[]>`
      select id from "order" where external_order_id = ${numero} limit 1
    `
    if (!ordine) {
      await anomalia(db, accountId, 'rimborso_ordine_sconosciuto', email, numero)
      return { esito: 'orfano' as const, thread_id: null }
    }

    // Stessa chiave di registraReso/registraAvviso: un rimborso sullo
    // stesso ordine finisce nella stessa conversazione.
    const chiave = `ordine:${ordine.id}`

    const [thread] = await tx<{ id: string; tags: string[] }[]>`
      insert into thread (
        account_id, external_thread_id, order_id, subject, state,
        first_inbound_at, last_inbound_at, due_at, tags
      ) values (
        ${accountId}, ${chiave}, ${ordine.id}, ${email.subject},
        ${vecchio ? 'closed' : 'open'}, ${arrivato}, ${arrivato}, ${scadenza},
        ${[TAG_RIMBORSO_EMESSO]}
      )
      on conflict (account_id, external_thread_id)
        where external_thread_id is not null
      do update set updated_at = now()
      returning id, tags
    `
    const t = thread!

    // L'unica difesa contro il duplicato è QUESTA insert: se la stessa
    // email è già stata processata (stesso rfc822_id), non inserisce
    // niente e sappiamo di non dover sommare di nuovo l'importo — a
    // differenza di resi.ts, qui non si salta in base a un tag già
    // presente, perché un secondo rimborso VERO sullo stesso ordine deve
    // contare.
    const [msg] = await tx<{ id: string }[]>`
      insert into message (
        thread_id, direction, author_kind, external_id, rfc822_id,
        body_text, sent_at, match_strategy, raw
      ) values (
        ${t.id}, 'in', 'system', ${email.rfc822_id}, ${email.rfc822_id},
        ${formattaRimborso(numero, dati)}, ${arrivato}, 'numero_ordine',
        ${tx.json(perArchivio(email) as never)}
      )
      on conflict (rfc822_id) where rfc822_id is not null do nothing
      returning id
    `
    const nuovo = Boolean(msg)

    if (nuovo) {
      if (!t.tags.includes(TAG_RIMBORSO_EMESSO)) {
        await tx`
          update thread set
            tags       = array_append(tags, ${TAG_RIMBORSO_EMESSO}),
            state      = ${vecchio ? tx`state` : tx`'open'`},
            due_at     = least(coalesce(due_at, ${scadenza}), ${scadenza}),
            updated_at = now()
          where id = ${t.id}
        `
      }

      await tx`
        update "order" set
          rimborso_totale    = coalesce(rimborso_totale, 0) + coalesce(${dati.importo_totale}, 0),
          rimborso_emesso_at = ${arrivato},
          updated_at         = now()
        where id = ${ordine.id}
      `

      if (!vecchio) {
        log.warn({ thread_id: t.id, ordine: numero, importo: dati.importo_totale }, 'rimborso emesso')
      }
    }

    return { esito: nuovo ? ('registrato' as const) : ('gia_visto' as const), thread_id: t.id }
  })
}
