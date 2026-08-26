import type { Config } from '../../config.js'
import type { Logger } from '../../logger.js'
import { creaFornitoreToken } from './token.js'

const API_VERSION = '2025-07'

/**
 * Registrazione dei webhook Shopify.
 *
 * Sono la via principale con cui gli ordini arrivano: senza, il database
 * si allinea solo al giro periodico e un cliente che scrive dieci minuti
 * dopo l'acquisto trova un ordine che per noi non esiste.
 *
 * Idempotente per costruzione: prima legge cosa c'è già e crea solo il
 * mancante. Rilanciarlo dieci volte non produce dieci sottoscrizioni.
 */

/**
 * I tre eventi che ci servono, e perché.
 *  - orders/create      l'ordine nuovo
 *  - orders/updated     stato pagamento ed evasione che cambiano
 *  - fulfillments/create il tracking, cioè la risposta a "dov'è il pacco"
 */
export const TOPIC = ['ORDERS_CREATE', 'ORDERS_UPDATED', 'FULFILLMENTS_CREATE'] as const

export interface EsitoWebhook {
  topic: string
  esito: 'creato' | 'già presente' | 'errore'
  dettaglio?: string
}

const LISTA = `
query { webhookSubscriptions(first: 50) {
  nodes { id topic endpoint { __typename ... on WebhookHttpEndpoint { callbackUrl } } }
} }`

const CREA = `
mutation Crea($topic: WebhookSubscriptionTopic!, $sub: WebhookSubscriptionInput!) {
  webhookSubscriptionCreate(topic: $topic, webhookSubscription: $sub) {
    webhookSubscription { id }
    userErrors { field message }
  }
}`

export async function registraWebhook(
  config: Config,
  log: Logger,
  baseUrl: string,
): Promise<EsitoWebhook[]> {
  if (!config.SHOPIFY_SHOP) throw new Error('SHOPIFY_SHOP non configurato')

  const callbackUrl = `${baseUrl.replace(/\/+$/, '')}/webhooks/shopify`
  const dammiToken = creaFornitoreToken(config, log)
  const url = `https://${config.SHOPIFY_SHOP}/admin/api/${API_VERSION}/graphql.json`

  const chiama = async (query: string, variables?: unknown) => {
    const r = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Shopify-Access-Token': await dammiToken(),
      },
      body: JSON.stringify({ query, variables }),
    })
    const testo = await r.text()
    if (!r.ok) {
      // 403 qui significa quasi sempre una cosa sola, e vale la pena dirla.
      if (r.status === 403) {
        throw new Error(
          "Shopify ha rifiutato l'operazione sui webhook (403). All'app manca " +
            'il permesso di gestirli: aggiungi lo scope write_webhooks nel Dev ' +
            'Dashboard, rilascia una nuova versione e reinstalla.',
        )
      }
      throw new Error(`Shopify ha risposto ${r.status}: ${testo.slice(0, 300)}`)
    }
    return JSON.parse(testo) as {
      data?: Record<string, unknown>
      errors?: unknown
    }
  }

  // --- Cosa c'è già ----------------------------------------------------
  const esistenti = await chiama(LISTA)
  if (esistenti.errors) {
    throw new Error(`GraphQL: ${JSON.stringify(esistenti.errors)}`)
  }

  const nodi =
    ((esistenti.data?.webhookSubscriptions as { nodes?: unknown[] })?.nodes ?? []) as Array<{
      topic?: string
      endpoint?: { callbackUrl?: string }
    }>

  const gia = new Set(
    nodi
      .filter((n) => n.endpoint?.callbackUrl === callbackUrl)
      .map((n) => n.topic)
      .filter((t): t is string => typeof t === 'string'),
  )

  // --- Il mancante ------------------------------------------------------
  const esiti: EsitoWebhook[] = []

  for (const topic of TOPIC) {
    if (gia.has(topic)) {
      esiti.push({ topic, esito: 'già presente' })
      continue
    }

    try {
      const r = await chiama(CREA, {
        topic,
        sub: { callbackUrl, format: 'JSON' },
      })
      const risultato = r.data?.webhookSubscriptionCreate as
        | { userErrors?: Array<{ message?: string }> }
        | undefined
      const errori = risultato?.userErrors ?? []
      if (errori.length > 0) {
        esiti.push({
          topic,
          esito: 'errore',
          dettaglio: errori.map((e) => e.message).join('; '),
        })
      } else {
        esiti.push({ topic, esito: 'creato' })
      }
    } catch (errore) {
      esiti.push({
        topic,
        esito: 'errore',
        dettaglio: errore instanceof Error ? errore.message : String(errore),
      })
    }
  }

  return esiti
}
