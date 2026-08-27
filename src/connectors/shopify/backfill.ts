import type { Config } from '../../config.js'
import type { Db } from '../../db/index.js'
import type { Logger } from '../../logger.js'
import { daGraphQL } from './normalize.js'
import { creaFornitoreToken } from './token.js'
import { upsertOrdine } from './upsert.js'

const API_VERSION = '2025-07'

const QUERY = `
query Ordini($first: Int!, $after: String, $query: String) {
  orders(first: $first, after: $after, query: $query, sortKey: CREATED_AT) {
    pageInfo { hasNextPage endCursor }
    nodes {
      id name sourceName sourceIdentifier tags createdAt
      displayFinancialStatus displayFulfillmentStatus
      currentTotalPriceSet { shopMoney { amount currencyCode } }
      customAttributes { key value }
      lineItems(first: 50) {
        nodes { title quantity sku originalUnitPriceSet { shopMoney { amount } } image { url } }
      }
      fulfillments(first: 1) { trackingInfo { number url company } }
      shippingAddress { name phone address1 address2 city province zip country }
      billingAddress { name phone address1 address2 city province zip country }
    }
  }
}`

/**
 * Recupero storico degli ordini.
 *
 * Il cursore si salva in sync_state dopo ogni pagina: un'interruzione a metà
 * non costringe a ricominciare da capo, e su qualche migliaio di ordini non è
 * un dettaglio.
 */
export async function backfillShopify(
  db: Db,
  log: Logger,
  config: Config,
  opts: { since?: string; pageSize?: number } = {},
): Promise<{ pagine: number; ordini: number; anomalie: number }> {
  if (!config.SHOPIFY_SHOP) {
    throw new Error('SHOPIFY_SHOP è obbligatorio per il backfill')
  }
  const dammiToken = creaFornitoreToken(config, log)

  const [account] = await db<{ id: string }[]>`
    select id from channel_account where kind = 'shopify' and active limit 1
  `
  const accountId = account?.id ?? null

  const [stato] = accountId
    ? await db<{ api_cursor: string | null }[]>`
        select api_cursor from sync_state where account_id = ${accountId}
      `
    : []

  let after: string | null = stato?.api_cursor ?? null
  let pagine = 0
  let ordini = 0
  let anomalie = 0

  const url = `https://${config.SHOPIFY_SHOP}/admin/api/${API_VERSION}/graphql.json`

  for (;;) {
    const risposta = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Shopify-Access-Token': await dammiToken(),
      },
      body: JSON.stringify({
        query: QUERY,
        variables: {
          first: opts.pageSize ?? 50,
          after,
          query: opts.since ? `created_at:>=${opts.since}` : null,
        },
      }),
    })

    if (risposta.status === 429) {
      // Shopify limita le richieste: aspetta e riprova la stessa pagina.
      log.warn('limite di richieste Shopify raggiunto, attesa di 2 secondi')
      await new Promise((r) => setTimeout(r, 2000))
      continue
    }
    if (!risposta.ok) {
      throw new Error(`Shopify ha risposto ${risposta.status}: ${await risposta.text()}`)
    }

    const body = (await risposta.json()) as {
      data?: { orders?: { pageInfo: { hasNextPage: boolean; endCursor: string }; nodes: unknown[] } }
      errors?: unknown
    }
    if (body.errors) throw new Error(`GraphQL: ${JSON.stringify(body.errors)}`)

    const page = body.data?.orders
    if (!page) break

    for (const node of page.nodes) {
      const esito = await upsertOrdine(db, log, daGraphQL(node as Record<string, unknown>))
      ordini += 1
      if (esito.anomalia) anomalie += 1
    }

    pagine += 1
    after = page.pageInfo.endCursor

    if (accountId) {
      await db`
        insert into sync_state (account_id, api_cursor, last_ok_at, consecutive_failures)
        values (${accountId}, ${after}, now(), 0)
        on conflict (account_id) do update set
          api_cursor = excluded.api_cursor,
          last_ok_at = now(),
          last_error = null,
          consecutive_failures = 0,
          updated_at = now()
      `
    }

    log.info({ pagine, ordini, anomalie }, 'pagina sincronizzata')
    if (!page.pageInfo.hasNextPage) break
  }

  return { pagine, ordini, anomalie }
}
