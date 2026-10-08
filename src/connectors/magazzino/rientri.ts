import type { Config } from '../../config.js'
import type { Db } from '../../db/index.js'
import type { Logger } from '../../logger.js'

/**
 * Rientri in magazzino: quando un cliente rispedisce un reso Amazon
 * autorizzato, il magazzino lo scansiona con un tool separato ("Utilities
 * Magazzino", altro progetto Lovable, altro database). Quel tool espone un
 * endpoint di sola lettura (`GET /api/public/rientri`) con le scansioni
 * valide; questo modulo lo interroga e, per ogni pacco riconosciuto come
 * un nostro ordine Amazon, riapre il ticket e avvisa l'operatore — senza
 * l'automazione, nessuno saprebbe che il pacco è arrivato finché il
 * cliente non scrive di nuovo a chiedere il rimborso.
 */

export const TAG_PACCO_RIENTRATO = 'pacco-rientrato-logistica'

const NOTA_RIENTRO = 'Pacco rientrato in logistica.'

export interface Rientro {
  id: string
  barcode: string | null
  internal_reference: string | null
  customer_name: string | null
  created_at: string
  /** Solo rientri in garanzia: il riferimento della pratica scritto dal magazzino. */
  pratica?: string | null
  /** Solo rientri in garanzia: l'esito deciso alla scansione (sostituzione, riparazione...). */
  action?: string | null
}

/**
 * Il numero d'ordine Amazon dal riferimento interno Zoho.
 *
 * Verificato sui dati veri del tool di magazzino (10/09), non assunto:
 * Zoho nomina i propri ordini di vendita per Amazon con il prefisso
 * "AMZS" seguito dal numero ordine reale — "AMZS407-9987997-0665947" è
 * l'ordine "407-9987997-0665947". Un riferimento che non segue questa
 * forma (garanzia, altri canali, "TTOK...", "A-...") restituisce null:
 * non è un nostro ordine Amazon, e forzare un match sbagliato sarebbe
 * peggio di non trovarne nessuno.
 */
export function estraiNumeroOrdineDaRiferimento(internalReference: string | null): string | null {
  if (!internalReference) return null
  const trovato = internalReference.trim().match(/^AMZS(\d{3}-\d{7}-\d{7})$/i)
  return trovato?.[1] ?? null
}

export async function recuperaRientri(
  config: Config,
  tipo: 'reso_ecommerce' | 'assistenza_garanzia' = 'reso_ecommerce',
): Promise<Rientro[]> {
  if (!config.MAGAZZINO_API_URL || !config.MAGAZZINO_API_TOKEN) {
    throw new Error(
      'Rientri magazzino non configurati: mancano MAGAZZINO_API_URL e/o MAGAZZINO_API_TOKEN.',
    )
  }

  const url = new URL(config.MAGAZZINO_API_URL)
  url.searchParams.set('package_type', tipo)

  const risposta = await fetch(url, {
    headers: { Authorization: `Bearer ${config.MAGAZZINO_API_TOKEN}` },
  })
  if (!risposta.ok) {
    const testo = await risposta.text().catch(() => '')
    throw new Error(`Lettura rientri magazzino fallita (${risposta.status}): ${testo.slice(0, 300)}`)
  }

  const corpo = (await risposta.json()) as { rientri?: Rientro[] }
  return corpo.rientri ?? []
}

export interface EsitoRientri {
  controllati: number
  agganciati: number
  /** Ticket aperti da zero: rientro di un ordine su cui il cliente non ha mai scritto. */
  aperti: number
  errori: number
}

export const TAG_RIENTRO_SENZA_CONTATTO = 'rientro-senza-contatto'

/**
 * Si aprono ticket nuovi solo per rientri recenti: l'endpoint restituisce
 * 60 giorni di scansioni, e al primo giro aprire un ticket per ogni
 * rientro di due mesi fa (rimborsi in gran parte già emessi) riempirebbe
 * la coda di lavoro già fatto.
 */
const GIORNI_APERTURA = 7

export function entroFinestraApertura(scansione: string, oggi: Date = new Date()): boolean {
  const t = new Date(scansione).getTime()
  return !Number.isNaN(t) && (oggi.getTime() - t) / 86_400_000 <= GIORNI_APERTURA
}

export function testoRientroSenzaContatto(numero: string, barcode: string | null): string {
  return (
    `Pacco dell'ordine ${numero} rientrato in logistica${barcode ? ` (collo ${barcode})` : ''}. ` +
    'Il cliente non ci ha scritto: verificare il motivo del rientro ' +
    "(per esempio rifiuto alla consegna) ed emettere il rimborso se dovuto."
  )
}

/**
 * Ticket nuovo sull'ordine, con la STESSA chiave usata da resi, avvisi e
 * annullamenti (`ordine:<id>`): se poi il cliente scrive, il messaggio
 * finisce in questa conversazione. Ordine segnaposto se non è ancora
 * arrivato da Shopify, come in resi.ts. L'account è quello Amazon (il
 * riferimento AMZS è sempre un ordine Amazon), scelto per genere, non per
 * codice.
 */
async function apriTicketRientro(db: Db, numero: string, rientro: Rientro): Promise<string | null> {
  return db.begin(async (tx) => {
    const [account] = await tx<{ id: string; sla_minutes: number }[]>`
      select id, sla_minutes from channel_account where kind = 'amazon' order by code limit 1
    `
    if (!account) return null
    const [ordine] = await tx<{ id: string }[]>`
      insert into "order" (channel, external_order_id)
      values ('amazon', ${numero})
      on conflict (channel, external_order_id) do update set updated_at = now()
      returning id
    `
    const scadenza = new Date(Date.now() + account.sla_minutes * 60_000)
    const [thread] = await tx<{ id: string; created: boolean }[]>`
      insert into thread (
        account_id, external_thread_id, order_id, subject, state, due_at, tags
      ) values (
        ${account.id}, ${`ordine:${ordine!.id}`}, ${ordine!.id},
        ${`Rientro in magazzino — ordine ${numero}`}, 'open', ${scadenza},
        ${[TAG_PACCO_RIENTRATO, TAG_RIENTRO_SENZA_CONTATTO]}
      )
      on conflict (account_id, external_thread_id)
        where external_thread_id is not null
      do update set updated_at = now()
      returning id, (xmax = 0) as created
    `
    // Una conversazione con questa chiave c'era già (senza ordine
    // collegato nella ricerca sopra): non si duplica la nota.
    if (!thread!.created) return null
    await tx`
      insert into message (thread_id, direction, author_kind, body_text, interno, sent_at)
      values (${thread!.id}, 'out', 'agent', ${testoRientroSenzaContatto(numero, rientro.barcode)}, true, now())
    `
    return thread!.id
  })
}

/**
 * Scrive la nota e riapre il ticket per ogni rientro riconosciuto.
 *
 * Idempotente sul tag {@link TAG_PACCO_RIENTRATO}: rileggere lo stesso
 * elenco di rientri (il giro periodico non tiene un segnalibro, rilegge
 * sempre una finestra ampia) non duplica la nota né riapre due volte lo
 * stesso ticket.
 */
export async function elaboraRientri(
  db: Db,
  log: Logger,
  rientri: Rientro[],
): Promise<EsitoRientri> {
  const esito: EsitoRientri = { controllati: 0, agganciati: 0, aperti: 0, errori: 0 }

  for (const rientro of rientri) {
    esito.controllati += 1
    const numero = estraiNumeroOrdineDaRiferimento(rientro.internal_reference)
    if (!numero) continue

    try {
      const [thread] = await db<{ id: string; tags: string[] }[]>`
        select t.id, t.tags
        from thread t
        join "order" o on o.id = t.order_id
        where o.external_order_id = ${numero}
        order by t.last_inbound_at desc nulls last
        limit 1
      `
      if (thread?.tags.includes(TAG_PACCO_RIENTRATO)) continue

      if (!thread) {
        // Nessuna conversazione: il cliente non ci ha mai scritto (caso
        // reale 06/10: pacco rifiutato alla consegna e reso dal corriere).
        // Il rimborso va emesso lo stesso, quindi serve un ticket.
        if (!entroFinestraApertura(rientro.created_at)) continue
        const aperto = await apriTicketRientro(db, numero, rientro)
        if (aperto) {
          esito.aperti += 1
          log.info({ thread_id: aperto, ordine: numero }, 'pacco rientrato senza conversazione: ticket aperto')
        }
        continue
      }

      await db.begin(async (tx) => {
        await tx`
          insert into message (thread_id, direction, author_kind, body_text, interno, sent_at)
          values (${thread.id}, 'out', 'agent', ${NOTA_RIENTRO}, true, now())
        `
        await tx`
          update thread set
            tags       = array_append(tags, ${TAG_PACCO_RIENTRATO}),
            state      = 'open',
            updated_at = now()
          where id = ${thread.id}
        `
      })

      esito.agganciati += 1
      log.info(
        { thread_id: thread.id, ordine: numero },
        'pacco rientrato in logistica: ticket riaperto',
      )
    } catch (errore) {
      esito.errori += 1
      log.error(
        { ordine: numero, err: errore instanceof Error ? errore.message : String(errore) },
        'elaborazione di un rientro magazzino fallita',
      )
    }
  }

  return esito
}
