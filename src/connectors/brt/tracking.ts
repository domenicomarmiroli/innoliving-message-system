import type { Config } from '../../config.js'
import type { Db } from '../../db/index.js'
import type { Logger } from '../../logger.js'
import { leggiPagina, urlPaginaBrt, type EventoBrt, type StatoBrt } from './pagina.js'

/**
 * Il giro di lettura del tracking BRT.
 *
 * Quali spedizioni: numero BRT a 12 cifre, non ancora consegnate, ordini
 * degli ultimi 45 giorni, di qualunque canale (non solo quelli con un
 * ticket: lo stato serve anche all'agente vocale e agli avvisi). Ognuna
 * si rilegge ogni `BRT_TRACKING_ORE`; appena risulta consegnata esce dalla
 * selezione da sola.
 *
 * Una pagina alla volta con una pausa fra l'una e l'altra
 * (`BRT_TRACKING_PAUSA_MS`): è il sito pubblico di BRT, non un'API.
 */

export const TAG_GIACENZA = 'spedizione-giacenza'
export const TAG_PROBLEMA = 'spedizione-problema'
export const TAG_RIENTRATO = 'spedizione-rientrata'

const GIORNI_FINESTRA = 45
const MASSIMO_PER_GIRO = 400
/** Dopo tante risposte di errore di fila, il sito non ci vuole: ci si ferma fino al giro dopo. */
const ERRORI_DI_FILA_MASSIMI = 3

const STATI_DI_AVVISO: ReadonlySet<StatoBrt> = new Set(['giacenza', 'problema', 'rientrato'])

export interface EsitoGiroBrt {
  letti: number
  aggiornati: number
  non_trovati: number
  non_riconosciuti: number
  avvisi: number
  errori: number
  interrotto: boolean
}

interface DaLeggere {
  id: string
  tracking_number: string
  spedizione_stato: string | null
}

/** Il testo della nota interna: l'evento come lo scrive BRT, con data e filiale. */
export function testoAvviso(stato: StatoBrt, evento: EventoBrt | undefined, numero: string): string {
  const titolo =
    stato === 'giacenza'
      ? 'Spedizione BRT in giacenza'
      : stato === 'rientrato'
        ? 'Spedizione BRT rientrata al mittente: il cliente non ha ricevuto il pacco, verificare rimborso o rispedizione'
        : 'Problema nella consegna BRT'
  if (!evento) return `${titolo} (spedizione ${numero}).`
  const quando = evento.data.split('-').reverse().join('/') + (evento.ora ? ` ${evento.ora}` : '')
  return `${titolo}: «${evento.evento}» — ${quando}${evento.filiale ? `, ${evento.filiale}` : ''} (spedizione ${numero}).`
}

async function scaricaPagina(numero: string): Promise<string> {
  const risposta = await fetch(urlPaginaBrt(numero), {
    headers: { Accept: 'text/html' },
    signal: AbortSignal.timeout(20_000),
  })
  if (!risposta.ok) throw new Error(`BRT ha risposto ${risposta.status}`)
  // La pagina dichiara una codifica Latin-1: leggerla come UTF-8 rovinerebbe
  // le lettere accentate (le parti che ci servono sono comunque ASCII).
  const byte = await risposta.arrayBuffer()
  const charset = /charset=([\w-]+)/i.exec(risposta.headers.get('content-type') ?? '')?.[1] ?? 'latin1'
  try {
    return new TextDecoder(charset).decode(byte)
  } catch {
    return new TextDecoder('latin1').decode(byte)
  }
}

async function avvisa(
  db: Db,
  log: Logger,
  orderId: string,
  stato: StatoBrt,
  evento: EventoBrt | undefined,
  numero: string,
): Promise<boolean> {
  const tag = stato === 'giacenza' ? TAG_GIACENZA : stato === 'rientrato' ? TAG_RIENTRATO : TAG_PROBLEMA
  const [thread] = await db<{ id: string }[]>`
    select id from thread
    where order_id = ${orderId}
    order by last_inbound_at desc nulls last, created_at desc
    limit 1
  `
  // Senza un ticket l'avviso resta sull'ordine (spedizione_stato), che
  // l'interfaccia elenca nella vista delle spedizioni con problemi.
  if (!thread) return false
  await db.begin(async (tx) => {
    await tx`
      insert into message (thread_id, direction, author_kind, body_text, interno, sent_at)
      values (${thread.id}, 'out', 'agent', ${testoAvviso(stato, evento, numero)}, true, now())
    `
    await tx`
      update thread set
        tags       = case when ${tag} = any(tags) then tags else array_append(tags, ${tag}) end,
        state      = 'open',
        updated_at = now()
      where id = ${thread.id}
    `
  })
  log.info({ thread_id: thread.id, stato }, 'avviso di spedizione BRT scritto sul ticket')
  return true
}

const pausa = (ms: number) => new Promise((r) => setTimeout(r, ms))

export async function giroTrackingBrt(
  db: Db,
  log: Logger,
  config: Config,
  fermato: () => boolean = () => false,
): Promise<EsitoGiroBrt> {
  const esito: EsitoGiroBrt = {
    letti: 0, aggiornati: 0, non_trovati: 0, non_riconosciuti: 0, avvisi: 0, errori: 0, interrotto: false,
  }

  // Rete di sicurezza: una spedizione segnata "consegnata" i cui eventi
  // parlano di reso al mittente si rilegge (è il bug del 06/10, e vale per
  // ogni regola di riconoscimento aggiunta in futuro).
  await db`
    update "order" set tracking_letto_at = null
    where spedizione_stato = 'consegnato'
      and tracking_eventi::text ~* 'RESO (AL )?MITT|RIENTR'
      and tracking_letto_at is not null
  `

  const daLeggere = await db<DaLeggere[]>`
    select id, tracking_number, spedizione_stato
    from "order"
    where tracking_number ~ '^[0-9]{12}$'
      -- "Amazon Logistics US" con un numero di 12 cifre è un'etichetta
      -- sbagliata alla fonte (06/10: 10 ordini Mirakl, numeri BRT veri):
      -- i tracking Amazon Logistics non sono mai solo cifre.
      and (carrier ilike 'brt%' or carrier ilike '%bartolini%' or tracking_url ilike '%brt.it%'
           or carrier ilike 'amazon logistics%')
      -- "consegnato" letto solo da Zoho (mai da BRT) si legge una volta:
      -- Zoho non distingue la consegna al cliente dal rientro a noi.
      and (spedizione_stato is null
           or spedizione_stato not in ('consegnato', 'rientrato')
           or (spedizione_stato = 'consegnato' and tracking_letto_at is null))
      and coalesce(placed_at, created_at) > now() - make_interval(days => ${GIORNI_FINESTRA})
      and (tracking_letto_at is null
           or tracking_letto_at < now() - make_interval(hours => ${config.BRT_TRACKING_ORE}))
    order by tracking_letto_at nulls first
    limit ${MASSIMO_PER_GIRO}
  `

  const nonRiconosciuti: { numero: string; motivo: string }[] = []
  let erroriDiFila = 0

  for (const o of daLeggere) {
    if (fermato()) break
    if (esito.letti > 0) await pausa(config.BRT_TRACKING_PAUSA_MS)
    esito.letti += 1

    let html: string
    try {
      html = await scaricaPagina(o.tracking_number)
      erroriDiFila = 0
    } catch (errore) {
      esito.errori += 1
      erroriDiFila += 1
      log.warn(
        { err: errore instanceof Error ? errore.message : String(errore) },
        'lettura pagina BRT fallita',
      )
      if (erroriDiFila >= ERRORI_DI_FILA_MASSIMI) {
        esito.interrotto = true
        break
      }
      continue
    }

    try {
      const pagina = leggiPagina(html)
      if (!pagina.riconosciuta) {
        esito.non_riconosciuti += 1
        nonRiconosciuti.push({ numero: o.tracking_number, motivo: pagina.motivo })
        await db`update "order" set tracking_letto_at = now() where id = ${o.id}`
        continue
      }
      if (!pagina.trovata) {
        esito.non_trovati += 1
        await db`update "order" set tracking_letto_at = now() where id = ${o.id}`
        continue
      }

      await db`
        update "order" set
          spedizione_stato           = ${pagina.stato},
          tracking_eventi            = ${db.json(pagina.eventi as unknown as Parameters<typeof db.json>[0])},
          tracking_consegna_prevista = ${pagina.consegna_prevista}::date,
          tracking_giacenza          = ${pagina.giacenza ? db.json(pagina.giacenza as unknown as Parameters<typeof db.json>[0]) : null},
          tracking_letto_at          = now(),
          spedizione_aggiornata_at   = now(),
          -- BRT ha trovato la spedizione: è sua, anche se la fonte la
          -- chiamava in un altro modo.
          carrier                    = 'BRT',
          tracking_url               = ${urlPaginaBrt(o.tracking_number)},
          updated_at                 = now()
        where id = ${o.id}
      `
      esito.aggiornati += 1

      // Un avviso solo al cambio di stato: rileggere ogni giorno una
      // giacenza già segnalata non deve riempire il ticket di note.
      if (STATI_DI_AVVISO.has(pagina.stato) && o.spedizione_stato !== pagina.stato) {
        if (await avvisa(db, log, o.id, pagina.stato, pagina.eventi[0], o.tracking_number)) {
          esito.avvisi += 1
        }
      }
    } catch (errore) {
      esito.errori += 1
      log.error(
        { order_id: o.id, err: errore instanceof Error ? errore.message : String(errore) },
        'scrittura del tracking BRT fallita',
      )
    }
  }

  // Regola 5: se BRT cambia la pagina non deve accadere in silenzio. Una
  // riga per giro, non una per spedizione.
  if (nonRiconosciuti.length > 0) {
    await db`
      insert into ingest_anomaly (tipo, payload)
      values ('brt_pagina_non_riconosciuta', ${db.json({ quante: nonRiconosciuti.length, esempi: nonRiconosciuti.slice(0, 5) })})
    `
  }

  return esito
}
