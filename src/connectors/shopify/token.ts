import type { Config } from '../../config.js'
import type { Logger } from '../../logger.js'

/**
 * Ottenimento del token Shopify con il "client credentials grant".
 *
 * Le app create nel Dev Dashboard che agiscono sui negozi della propria
 * organizzazione non espongono nessun token da copiare: se lo richiedono da
 * sole scambiando client id e secret. Il token vale 24 ore, quindi va messo
 * in cache e rinnovato prima della scadenza — richiederne uno nuovo a ogni
 * chiamata funzionerebbe, ma sprecherebbe una richiesta ogni volta.
 *
 * Resta supportato anche il token statico `shpat_...` delle vecchie app
 * create dall'admin del negozio: se è configurato, ha la precedenza e non si
 * chiama nulla.
 */

interface TokenInCache {
  token: string
  scadenza: number // epoch ms
}

const MARGINE_MS = 5 * 60 * 1000 // rinnova 5 minuti prima della scadenza

export interface FornitoreToken {
  (): Promise<string>
}

export function creaFornitoreToken(config: Config, log: Logger): FornitoreToken {
  // Token statico: vecchie app create dall'admin del negozio.
  if (config.SHOPIFY_ADMIN_TOKEN) {
    const statico = config.SHOPIFY_ADMIN_TOKEN
    return async () => statico
  }

  if (!config.SHOPIFY_CLIENT_ID || !config.SHOPIFY_CLIENT_SECRET) {
    return async () => {
      throw new Error(
        'Nessuna credenziale Shopify: servono SHOPIFY_CLIENT_ID e SHOPIFY_CLIENT_SECRET, ' +
          'oppure SHOPIFY_ADMIN_TOKEN per le vecchie app create dall\'admin.',
      )
    }
  }

  let cache: TokenInCache | null = null
  let inCorso: Promise<string> | null = null

  const richiedi = async (): Promise<string> => {
    const url = `https://${config.SHOPIFY_SHOP}/admin/oauth/access_token`
    const risposta = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        client_id: config.SHOPIFY_CLIENT_ID,
        client_secret: config.SHOPIFY_CLIENT_SECRET,
        grant_type: 'client_credentials',
      }),
    })

    const testo = await risposta.text()
    if (!risposta.ok) {
      // Errore tipico e non ovvio: app e negozio non stanno nella stessa
      // organizzazione del Dev Dashboard. Vale la pena dirlo per esteso,
      // perché il messaggio di Shopify da solo non suggerisce la causa.
      if (testo.includes('shop_not_permitted')) {
        throw new Error(
          `Shopify rifiuta le credenziali per ${config.SHOPIFY_SHOP}: il negozio non risulta ` +
            'nella stessa organizzazione dell\'app. Nel Dev Dashboard, verifica che il negozio ' +
            'compaia in "Dev stores" e che SHOPIFY_SHOP corrisponda esattamente al sottodominio ' +
            'myshopify.com.',
        )
      }
      throw new Error(`Richiesta del token fallita (${risposta.status}): ${testo}`)
    }

    const dati = JSON.parse(testo) as {
      access_token?: string
      scope?: string
      expires_in?: number
    }
    if (!dati.access_token) throw new Error(`Risposta senza access_token: ${testo}`)

    const durata = (dati.expires_in ?? 86399) * 1000
    cache = { token: dati.access_token, scadenza: Date.now() + durata }

    log.info(
      { scope: dati.scope, scade_fra_minuti: Math.round(durata / 60000) },
      'token Shopify ottenuto',
    )
    return dati.access_token
  }

  return async () => {
    if (cache && Date.now() < cache.scadenza - MARGINE_MS) return cache.token
    // Se una richiesta è già in volo, aspettiamo quella: senza questo, dieci
    // chiamate in parallelo dopo la scadenza farebbero dieci richieste.
    if (inCorso) return inCorso
    inCorso = richiedi().finally(() => {
      inCorso = null
    })
    return inCorso
  }
}

/** Solo per i test: quali scope ha davvero il token, secondo Shopify. */
export function leggiScope(rispostaJson: string): string[] {
  const dati = JSON.parse(rispostaJson) as { scope?: string }
  return (dati.scope ?? '').split(',').map((s) => s.trim()).filter(Boolean)
}
