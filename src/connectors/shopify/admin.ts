import type { Config } from '../../config.js'
import type { Logger } from '../../logger.js'
import { creaFornitoreToken, type FornitoreToken } from './token.js'

/**
 * Chiamata GraphQL all'Admin API per le operazioni dell'operatore (ordine
 * sostitutivo, codice sconto). Il giro degli ordini ha il suo ciclo con la
 * paginazione; qui serve una chiamata singola con gli errori leggibili.
 */

// Versione recente: il campo context degli sconti non esiste nelle versioni vecchie.
export const API_VERSION = '2026-07'

let fornitore: FornitoreToken | null = null

export class ErroreShopify extends Error {
  constructor(messaggio: string, public readonly permessoMancante = false) {
    super(messaggio)
  }
}

export async function chiamaAdmin<T>(
  config: Config,
  log: Logger,
  query: string,
  variables: Record<string, unknown> = {},
): Promise<T> {
  if (!config.SHOPIFY_SHOP) throw new ErroreShopify('SHOPIFY_SHOP non configurato')
  fornitore ??= creaFornitoreToken(config, log)
  const url = `https://${config.SHOPIFY_SHOP}/admin/api/${API_VERSION}/graphql.json`

  for (let tentativo = 0; tentativo < 3; tentativo++) {
    const risposta = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Shopify-Access-Token': await fornitore() },
      body: JSON.stringify({ query, variables }),
    })
    if (risposta.status === 429) {
      await new Promise((r) => setTimeout(r, 2000))
      continue
    }
    const testo = await risposta.text()
    if (!risposta.ok) throw new ErroreShopify(`Shopify ha risposto ${risposta.status}: ${testo.slice(0, 500)}`)
    const body = JSON.parse(testo) as { data?: T; errors?: { message?: string; extensions?: { code?: string } }[] }
    if (body.errors?.length) {
      const accesso = body.errors.some(
        (e) => e.extensions?.code === 'ACCESS_DENIED' || /access denied|scope/i.test(e.message ?? ''),
      )
      throw new ErroreShopify(
        accesso
          ? "L'app Shopify dell'Hub non ha il permesso per questa operazione (servono read_products, write_orders e write_discounts): va approvato sul negozio. " +
            `Shopify dice: ${body.errors.map((e) => e.message).join('; ').slice(0, 400)}`
          : `GraphQL: ${body.errors.map((e) => e.message).join('; ')}`,
        accesso,
      )
    }
    if (!body.data) throw new ErroreShopify('Risposta Shopify senza dati')
    return body.data
  }
  throw new ErroreShopify('Shopify: troppe richieste, riprova fra poco')
}
