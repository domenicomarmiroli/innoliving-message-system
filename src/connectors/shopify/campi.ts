/**
 * I campi di un ordine chiesti a Shopify, uguali per backfill e
 * allineamento periodico: prima erano due copie della stessa lista, e
 * una correzione fatta su una sola delle due sarebbe passata inosservata.
 *
 * `email` è un dato cliente protetto: Shopify lo restituisce solo se
 * l'app ha l'accesso approvato a quel campo. Senza, la query intera
 * torna con un errore di accesso — e l'allineamento degli ordini si
 * fermerebbe per un campo che serve solo alla verifica telefonica. Per
 * questo chi interroga riprova senza `email` quando l'errore riguarda
 * solo quel campo (`erroreSoloEmail`).
 */
export function campiOrdine(conEmail: boolean): string {
  return `
      id name sourceName sourceIdentifier tags createdAt updatedAt cancelledAt${conEmail ? ' email' : ''}
      displayFinancialStatus displayFulfillmentStatus
      currentTotalPriceSet { shopMoney { amount currencyCode } }
      customAttributes { key value }
      lineItems(first: 50) {
        nodes { title quantity sku originalUnitPriceSet { shopMoney { amount } } image { url } }
      }
      fulfillments(first: 1) { createdAt trackingInfo { number url company } }
      shippingAddress { name phone address1 address2 city province zip country }
      billingAddress { name phone address1 address2 city province zip country }`
}

/**
 * Se l'app può leggere `email`. Si scopre alla prima risposta e vale per
 * tutta la vita del processo: un riavvio riprova, così concedere il
 * permesso in Shopify non richiede nessuna modifica qui.
 */
export const accessoEmail = { disponibile: true }

/** True se TUTTI gli errori GraphQL riguardano il campo `email`. */
export function erroreSoloEmail(errori: unknown): boolean {
  if (!Array.isArray(errori) || errori.length === 0) return false
  return errori.every((e) => {
    const percorso = (e as { path?: unknown })?.path
    const messaggio = String((e as { message?: unknown })?.message ?? '')
    const nelPercorso = Array.isArray(percorso) && percorso.at(-1) === 'email'
    return nelPercorso || /\bemail\b/i.test(messaggio)
  })
}
