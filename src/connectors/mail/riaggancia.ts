import type { Db } from '../../db/index.js'
import type { Logger } from '../../logger.js'
import { caricaRegole } from './regole.js'
import { estraiNumeroOrdine } from './riconosci.js'

/**
 * Riaggancio delle conversazioni rimaste senza ordine.
 *
 * Un messaggio può arrivare PRIMA del suo ordine, e non è un caso
 * eccezionale: gli ordini Amazon oggi non passano dallo Shopify, e anche
 * quando passeranno una email può precedere il webhook di pochi secondi.
 * Un aggancio che avviene una volta sola, al momento dell'ingestione,
 * sbaglierebbe per sempre.
 *
 * Quindi si riprova. Ogni giro di polling ripassa le conversazioni senza
 * ordine e le aggancia se nel frattempo l'ordine è comparso. Il giorno
 * in cui la sincronizzazione Amazon si accende, quelle che aspettano si
 * sistemano da sole entro un minuto: nessuno deve ricordarsi di lanciare
 * niente.
 *
 * Sono poche righe e solo quelle non agganciate, quindi costa poco; e
 * appena una si aggancia esce dall'insieme.
 */

export interface EsitoRiaggancio {
  esaminate: number
  agganciate: number
}

const LIMITE = 1000

export async function riaggancia(
  db: Db,
  log: Logger,
): Promise<EsitoRiaggancio> {
  const { regole } = await caricaRegole(db)
  const patternPerAccount = new Map(
    regole.map((r) => [r.account_id, r.order_id_pattern]),
  )

  const righe = await db<
    {
      id: string
      account_id: string
      state: string
      subject: string | null
      body_text: string | null
    }[]
  >`
    select t.id, t.account_id, t.state,
           m.raw->>'subject'   as subject,
           m.raw->>'body_text' as body_text
    from thread t
    join lateral (
      select raw from message
      where thread_id = t.id and direction = 'in'
      order by sent_at
      limit 1
    ) m on true
    where t.order_id is null
    limit ${LIMITE}
  `

  let agganciate = 0

  for (const r of righe) {
    const numero = estraiNumeroOrdine(
      {
        subject: r.subject,
        body_text: r.body_text,
        // il resto non serve all'estrazione
        rfc822_id: null, in_reply_to: null, references: [], from: null,
        reply_to: null, to: [], date: null, body_html: null,
        allegati: [], uid: null,
      },
      patternPerAccount.get(r.account_id) ?? null,
    )
    if (!numero) continue

    const [ordine] = await db<{ id: string }[]>`
      select id from "order" where external_order_id = ${numero} limit 1
    `
    if (!ordine) continue

    // La chiave canonica della conversazione è quella dell'ordine, ma
    // solo se nessun'altra la occupa già: due conversazioni sullo stesso
    // ordine vanno unite, e unirle è un problema diverso da questo.
    const [occupata] = await db<{ id: string }[]>`
      select id from thread
      where account_id = ${r.account_id}
        and external_thread_id = ${'ordine:' + ordine.id}
        and id <> ${r.id}
      limit 1
    `

    await db`
      update thread set
        order_id           = ${ordine.id},
        external_thread_id = ${occupata ? db`external_thread_id` : 'ordine:' + ordine.id},
        -- Una conversazione già chiusa resta chiusa: agganciarla a un
        -- ordine è un miglioramento dell'archivio, non lavoro nuovo.
        state              = case when state = 'unmatched' then 'open' else state end,
        updated_at         = now()
      where id = ${r.id}
    `
    agganciate += 1
  }

  if (agganciate > 0) {
    log.info(
      { esaminate: righe.length, agganciate },
      'conversazioni agganciate a un ordine comparso dopo',
    )
  }

  return { esaminate: righe.length, agganciate }
}
