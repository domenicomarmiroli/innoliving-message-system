import type { Config } from '../../config.js'
import type { Db } from '../../db/index.js'
import type { Logger } from '../../logger.js'
import { daGraphQL } from './normalize.js'
import { creaFornitoreToken } from './token.js'
import { upsertOrdine } from './upsert.js'

const API_VERSION = '2025-07'

/**
 * Allineamento periodico degli ordini.
 *
 * I webhook restano la via principale — un ordine deve comparire in
 * pochi secondi, non fra un'ora — ma un sistema che si fida solo dei
 * webhook prima o poi perde qualcosa: un riavvio durante il deploy, un
 * 500 momentaneo, una notifica che Shopify ritenta e poi abbandona.
 * Questo giro periodico è la rete sotto: ripassa ciò che è cambiato e
 * riscrive, e siccome la scrittura è idempotente ripassare non costa.
 *
 * La differenza con il backfill: quello guarda `created_at` e serve una
 * volta sola, questo guarda **`updated_at`**. Un ordine spedito ieri e
 * tracciato oggi non è nuovo, ma è cambiato — e il tracking è
 * esattamente il dato che serve a rispondere "dov'è il mio pacco".
 */

const QUERY = `
query OrdiniAggiornati($first: Int!, $after: String, $query: String) {
  orders(first: $first, after: $after, query: $query, sortKey: UPDATED_AT) {
    pageInfo { hasNextPage endCursor }
    nodes {
      id name sourceName sourceIdentifier tags createdAt updatedAt
      displayFinancialStatus displayFulfillmentStatus
      currentTotalPriceSet { shopMoney { amount currencyCode } }
      customAttributes { key value }
      lineItems(first: 50) {
        nodes { title quantity sku originalUnitPriceSet { shopMoney { amount } } image { url } }
      }
      fulfillments(first: 1) { trackingInfo { number url company } }
    }
  }
}`

/**
 * Quanto si arretra rispetto all'inizio del giro precedente.
 * Fra il momento in cui leggiamo e quello in cui salviamo passa tempo:
 * un ordine modificato in quell'intervallo, senza sovrapposizione,
 * andrebbe perso per sempre.
 */
const SOVRAPPOSIZIONE_MS = 10 * 60_000

/** Alla prima esecuzione, quanto indietro guardare. */
const PRIMA_VOLTA_MS = 24 * 60 * 60_000

const PAGINE_MAX = 100

export interface EsitoIncrementale {
  ordini: number
  pagine: number
  anomalie: number
  da: string
}

export async function sincronizzaOrdiniShopify(
  db: Db,
  log: Logger,
  config: Config,
): Promise<EsitoIncrementale> {
  if (!config.SHOPIFY_SHOP) {
    throw new Error('SHOPIFY_SHOP non configurato: allineamento ordini saltato')
  }

  const inizioGiro = new Date()
  const da = await leggiSegnalibro(db)
  const dammiToken = creaFornitoreToken(config, log)
  const url = `https://${config.SHOPIFY_SHOP}/admin/api/${API_VERSION}/graphql.json`

  const esito: EsitoIncrementale = { ordini: 0, pagine: 0, anomalie: 0, da }

  let after: string | null = null

  for (;;) {
    const risposta = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Shopify-Access-Token': await dammiToken(),
      },
      body: JSON.stringify({
        query: QUERY,
        variables: { first: 50, after, query: `updated_at:>='${da}'` },
      }),
    })

    if (risposta.status === 429) {
      log.warn({}, 'limite di richieste Shopify: attesa e nuovo tentativo')
      await new Promise((r) => setTimeout(r, 2000))
      continue
    }
    if (!risposta.ok) {
      throw new Error(`Shopify ha risposto ${risposta.status}: ${await risposta.text()}`)
    }

    const body = (await risposta.json()) as {
      data?: {
        orders?: {
          pageInfo: { hasNextPage: boolean; endCursor: string }
          nodes: unknown[]
        }
      }
      errors?: unknown
    }
    if (body.errors) throw new Error(`GraphQL: ${JSON.stringify(body.errors)}`)

    const page = body.data?.orders
    if (!page) break

    for (const node of page.nodes) {
      const r = await upsertOrdine(db, log, daGraphQL(node as Record<string, unknown>))
      esito.ordini += 1
      if (r.anomalia) esito.anomalie += 1
    }

    esito.pagine += 1
    after = page.pageInfo.endCursor

    if (!page.pageInfo.hasNextPage) break
    if (esito.pagine >= PAGINE_MAX) {
      // Un limite silenzioso si legge come "ho finito" quando non è vero.
      log.warn(
        { pagine: esito.pagine },
        'raggiunto il limite di pagine: il resto al prossimo giro',
      )
      // Il segnalibro NON si sposta fino in fondo: al prossimo giro si
      // riparte da dove eravamo, non da adesso.
      return esito
    }
  }

  // Il segnalibro si sposta solo se il giro è arrivato in fondo.
  await salvaSegnalibro(db, new Date(inizioGiro.getTime() - SOVRAPPOSIZIONE_MS))
  return esito
}

// ---------------------------------------------------------------------
// Segnalibro
//
// In app_config e non in sync_state.api_cursor: quel campo, per
// l'account Shopify, contiene il cursore di paginazione del backfill.
// Sovrascriverlo con una data romperebbe la ripresa di un backfill
// interrotto, che è proprio la cosa che quel cursore serve a proteggere.
// ---------------------------------------------------------------------

const CHIAVE = 'shopify_sync'

async function leggiSegnalibro(db: Db): Promise<string> {
  const [riga] = await db<{ value: { updated_since?: unknown } }[]>`
    select value from app_config where key = ${CHIAVE}
  `
  const v = riga?.value?.updated_since
  if (typeof v === 'string' && v.length > 0) return v
  return new Date(Date.now() - PRIMA_VOLTA_MS).toISOString()
}

async function salvaSegnalibro(db: Db, quando: Date): Promise<void> {
  await db`
    insert into app_config (key, value)
    values (${CHIAVE}, ${db.json({ updated_since: quando.toISOString() })})
    on conflict (key) do update set
      value = excluded.value, updated_at = now()
  `
}
