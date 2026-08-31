import type { Db } from '../../db/index.js'
import type { Logger } from '../../logger.js'
import { anomalia } from './notifica.js'
import { perArchivio } from './parse.js'
import { estraiNumeroOrdine } from './riconosci.js'
import type { EmailGrezza } from './tipi.js'

/**
 * Reclami di Garanzia dalla A alla Z (`X-Space-Notification-Type:
 * A_Z_CLAIM_RESPONDENT_NOTIFY`).
 *
 * È la cosa più urgente che passa da questa casella: pesa sulla salute
 * dell'account venditore, e Amazon dà un termine breve per rispondere
 * ("deve rispondere entro N giorni di calendario" — verificato 3 giorni
 * sull'esemplare reale, ma il numero potrebbe variare, quindi lo
 * leggiamo dal testo invece di assumerlo fisso).
 *
 * **Perché un genere a parte e non il meccanismo `avviso` già esistente
 * (`notifica.ts`, per testo nell'oggetto)**: verificato su un esemplare
 * reale che il testo dell'oggetto di questa email ("Richiesta di
 * rimborso ricevuta per l'ordine...") NON contiene "dalla A alla Z" —
 * solo il corpo lo dice. Il vecchio meccanismo, basato sul testo
 * dell'oggetto, l'avrebbe classificato col tag generico
 * "avviso-piattaforma", perdendo l'urgenza specifica. L'header invece è
 * inequivocabile — stesso motivo per cui resi e rimborsi (resi.ts,
 * rimborsi.ts) usano l'header e non il testo.
 *
 * Stesso schema di resi.ts, incluso l'ordine segnaposto quando l'ordine
 * non è ancora in archivio: un reclamo A-to-Z può arrivare per un
 * ordine Amazon mai sincronizzato da Shopify.
 *
 * Verificato su un'email reale — vedi
 * test/fixtures/mail/amazon-reclamo-az-reale.eml, ordine
 * 402-3427577-1965903 — non scritto sulla sola documentazione: qui la
 * documentazione pubblica di Amazon non esiste nemmeno, come per resi e
 * rimborsi.
 *
 * **DEBITO dichiarato**: verificato solo l'esemplare della notifica
 * iniziale del reclamo. Amazon dice esplicitamente che manderà
 * un'altra email quando prenderà una decisione ("Non appena prenderemo
 * una decisione, invieremo... una email di notifica") — probabilmente
 * con lo stesso header, ma il formato di QUELLA email non è stato
 * ancora visto. Finché non arriva un esemplare vero, registraReclamo
 * tratta ogni notifica come un evento indipendente sullo stesso ordine
 * (stesso dedup per rfc822_id di tutti gli altri moduli): non perde
 * niente, ma non distingue "reclamo aperto" da "decisione presa".
 */

export const TAG_RECLAMO_AZ = 'reclamo-az'

export interface DatiReclamo {
  importo: number | null
  scadenza_risposta_giorni: number | null
}

/**
 * Importo dalla frase "abbiamo ricevuto un reclamo dalla A alla Z di
 * 119,00 € per l'ordine...". A differenza dei rimborsi (formato
 * americano, punto decimale: "169.01"), qui Amazon usa il formato
 * italiano con la virgola come separatore decimale — verificato
 * sull'esemplare reale, non assunto.
 */
function estraiImporto(html: string): number | null {
  const trovato = html.match(/reclamo dalla A alla Z di\s*([\d.,]+)/i)
  if (!trovato) return null
  const numero = Number(trovato[1]!.replace(/\./g, '').replace(',', '.'))
  return Number.isFinite(numero) ? numero : null
}

/** "Deve rispondere entro 3 giorni di calendario." — il numero non è assunto fisso. */
function estraiScadenzaGiorni(html: string): number | null {
  const trovato = html.match(/entro\s+(\d+)\s+giorni/i)
  if (!trovato) return null
  const numero = Number(trovato[1])
  return Number.isFinite(numero) ? numero : null
}

export function estraiDatiReclamo(html: string | null): DatiReclamo {
  if (!html) return { importo: null, scadenza_risposta_giorni: null }
  return {
    importo: estraiImporto(html),
    scadenza_risposta_giorni: estraiScadenzaGiorni(html),
  }
}

/** Il riassunto leggibile che finisce in `message.body_text`. */
export function formattaReclamo(numeroOrdine: string, dati: DatiReclamo): string {
  const righe: string[] = [
    `Reclamo di Garanzia dalla A alla Z ricevuto da Amazon per l'ordine ${numeroOrdine}.`,
  ]
  if (dati.importo !== null) righe.push(`Importo: EUR ${dati.importo}`)
  if (dati.scadenza_risposta_giorni !== null) {
    righe.push(`Termine per rispondere: ${dati.scadenza_risposta_giorni} giorni di calendario.`)
  }
  return righe.join('\n')
}

export interface EsitoReclamo {
  esito: 'aperto' | 'aggiornato' | 'gia_visto' | 'orfano'
  thread_id: string | null
}

export async function registraReclamo(
  db: Db,
  log: Logger,
  email: EmailGrezza,
  accountId: string,
  orderIdPattern: string | null,
  opzioni: { avviso_sla_minuti: number; giorni_coda: number },
): Promise<EsitoReclamo> {
  const numero = estraiNumeroOrdine(email, orderIdPattern)
  if (!numero) {
    await anomalia(db, accountId, 'reclamo_senza_ordine', email)
    return { esito: 'orfano', thread_id: null }
  }

  const dati = estraiDatiReclamo(email.body_html)
  const arrivato = email.date ?? new Date()
  const vecchio = (Date.now() - arrivato.getTime()) / 86_400_000 > opzioni.giorni_coda
  const scadenza = new Date(arrivato.getTime() + opzioni.avviso_sla_minuti * 60_000)

  return db.begin(async (tx) => {
    // Ordine segnaposto se non ancora in archivio — stessa scelta di
    // resi.ts/rimborsi.ts, stesso motivo (ordini Amazon non sincronizzati).
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
        'ordine creato come segnaposto: reclamo A-to-Z arrivato prima della sincronizzazione da Shopify',
      )
    }

    // reclamo_az_ricevuto_at sempre, coalesce mantiene la prima data
    // vista — un reclamo ha senso una volta sola per ordine, come un
    // reso, a differenza dei rimborsi che possono ripetersi.
    await tx`
      update "order" set
        reclamo_az_ricevuto_at = coalesce(reclamo_az_ricevuto_at, ${arrivato}),
        reclamo_az_importo     = coalesce(reclamo_az_importo, ${dati.importo}::numeric),
        updated_at             = now()
      where id = ${ordineId}
    `

    const chiave = `ordine:${ordineId}`

    const [thread] = await tx<{ id: string; tags: string[]; created: boolean }[]>`
      insert into thread (
        account_id, external_thread_id, order_id, subject, state,
        first_inbound_at, last_inbound_at, due_at, tags
      ) values (
        ${accountId}, ${chiave}, ${ordineId}, ${email.subject},
        ${vecchio ? 'closed' : 'open'}, ${arrivato}, ${arrivato}, ${scadenza},
        ${[TAG_RECLAMO_AZ]}
      )
      on conflict (account_id, external_thread_id)
        where external_thread_id is not null
      do update set updated_at = now()
      returning id, tags, (xmax = 0) as created
    `

    const t = thread!
    const gia_visto = !t.created && t.tags.includes(TAG_RECLAMO_AZ)

    if (!t.created && !gia_visto) {
      await tx`
        update thread set
          tags       = array_append(tags, ${TAG_RECLAMO_AZ}),
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
          body_text, sent_at, match_strategy, tipo_evento, importo, importo_valuta, raw
        ) values (
          ${t.id}, 'in', 'system', ${email.rfc822_id}, ${email.rfc822_id},
          ${formattaReclamo(numero, dati)}, ${arrivato}, 'numero_ordine', 'reclamo_az',
          ${dati.importo}, ${dati.importo !== null ? 'EUR' : null},
          ${tx.json(perArchivio(email) as never)}
        )
        on conflict (rfc822_id) where rfc822_id is not null do nothing
      `
    }

    if (!vecchio && !gia_visto) {
      log.warn({ thread_id: t.id, ordine: numero, importo: dati.importo }, 'reclamo A-to-Z ricevuto')
    }

    return {
      esito: gia_visto ? ('gia_visto' as const) : t.created ? ('aperto' as const) : ('aggiornato' as const),
      thread_id: t.id,
    }
  })
}
