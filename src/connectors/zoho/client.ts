import type { Config } from '../../config.js'

/**
 * Zoho Inventory, REST diretto (niente SDK, come Storage e Mirakl).
 *
 * Autenticazione: "Self Client" della Zoho API Console, refresh token
 * scambiato per un access token valido un'ora e tenuto in memoria.
 * Scope necessari: ZohoInventory.salesorders.READ e
 * ZohoInventory.custommodules.CREATE.
 */

let cache: { token: string; scade: number } | null = null

export function zohoConfigurato(config: Config): boolean {
  return Boolean(config.ZOHO_CLIENT_ID && config.ZOHO_CLIENT_SECRET && config.ZOHO_REFRESH_TOKEN && config.ZOHO_ORGANIZATION_ID)
}

async function accessToken(config: Config): Promise<string> {
  if (cache && cache.scade > Date.now() + 60_000) return cache.token
  const parametri = new URLSearchParams({
    refresh_token: config.ZOHO_REFRESH_TOKEN!,
    client_id: config.ZOHO_CLIENT_ID!,
    client_secret: config.ZOHO_CLIENT_SECRET!,
    grant_type: 'refresh_token',
  })
  const r = await fetch(`${config.ZOHO_ACCOUNTS_URL}/oauth/v2/token`, { method: 'POST', body: parametri, signal: AbortSignal.timeout(15_000) })
  const corpo = (await r.json().catch(() => ({}))) as { access_token?: string; expires_in?: number; error?: string }
  if (!r.ok || !corpo.access_token) {
    throw new Error(`Zoho: rinnovo del token fallito (${r.status} ${corpo.error ?? ''}). Controlla client id, secret e refresh token.`)
  }
  cache = { token: corpo.access_token, scade: Date.now() + (corpo.expires_in ?? 3600) * 1000 }
  return cache.token
}

async function chiama(config: Config, metodo: 'GET' | 'POST', percorso: string, query: Record<string, string>, corpo?: unknown) {
  const url = new URL(`${config.ZOHO_API_URL}/inventory/v1/${percorso}`)
  url.searchParams.set('organization_id', config.ZOHO_ORGANIZATION_ID!)
  for (const [k, v] of Object.entries(query)) url.searchParams.set(k, v)
  const r = await fetch(url, {
    method: metodo,
    headers: {
      Authorization: `Zoho-oauthtoken ${await accessToken(config)}`,
      ...(corpo ? { 'Content-Type': 'application/json' } : {}),
    },
    body: corpo ? JSON.stringify(corpo) : undefined,
    signal: AbortSignal.timeout(20_000),
  })
  const json = (await r.json().catch(() => ({}))) as Record<string, unknown> & { code?: number; message?: string }
  if (!r.ok || (json.code !== undefined && json.code !== 0)) {
    throw new Error(`Zoho ${metodo} ${percorso}: ${r.status} codice ${json.code ?? '?'} ${json.message ?? ''}`.trim())
  }
  return json
}

export interface OrdineVenditaZoho {
  salesorder_number: string
  reference_number: string | null
}

/** Ordini di vendita che contengono il testo cercato (numero o riferimento). */
export async function cercaOrdiniVendita(config: Config, testo: string): Promise<OrdineVenditaZoho[]> {
  const json = await chiama(config, 'GET', 'salesorders', { search_text: testo })
  const elenco = Array.isArray(json.salesorders) ? (json.salesorders as Record<string, unknown>[]) : []
  return elenco
    .filter((s) => typeof s.salesorder_number === 'string')
    .map((s) => ({
      salesorder_number: s.salesorder_number as string,
      reference_number: typeof s.reference_number === 'string' && s.reference_number ? s.reference_number : null,
    }))
}

/**
 * Riga nel modulo personalizzato "LDV Reso": i tre campi del vecchio
 * worker più la tipologia del reso, lo stesso testo stampato sul foglio.
 * `record_name` non va inviato: Zoho lo ricava dal segnacollo, e se lo
 * si manda risponde con errore 14805.
 */
export async function creaRigaLdvReso(config: Config, modulo: string, riga: { data: string; segnacollo: string; ordine: string; tipologia: string }) {
  await chiama(config, 'POST', modulo, {}, {
    cf_data_di_creazione: riga.data,
    cf_ldv_reso_amazon: riga.segnacollo,
    cf_numero_ordine_con_prefisso: riga.ordine,
    cf_tipologia_reso: riga.tipologia,
  })
}
