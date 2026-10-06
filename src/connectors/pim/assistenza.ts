import postgres from 'postgres'

import type { Config } from '../../config.js'

/**
 * Lettura del PIM per l'assistenza (agente vocale di primo livello).
 *
 * Il PIM è un altro progetto con un altro database: la verità sui
 * prodotti sta lì, non qui. Il worker si collega con il ruolo
 * `hub_assistenza` (migrazione 0225 del PIM), che può eseguire SOLO le
 * quattro funzioni `assistenza_*` e non vede nessuna tabella: niente
 * prezzi, costi o margini, niente scritture. Le funzioni restituiscono
 * già JSON pronto; qui non si interpreta niente, si inoltra.
 *
 * Senza `PIM_DB_URL` gli strumenti prodotto rispondono "servizio non
 * disponibile" e l'agente apre un ticket, come per qualunque guasto.
 */

type ClientPim = ReturnType<typeof postgres>

let client: ClientPim | null = null

function pim(config: Config): ClientPim {
  if (!config.PIM_DB_URL) throw new Error('PIM_DB_URL non impostata: lettura del PIM non disponibile.')
  if (!client) {
    client = postgres(config.PIM_DB_URL, {
      max: 3,
      idle_timeout: 30,
      connect_timeout: 5,
      prepare: false,
      onnotice: () => {},
    })
  }
  return client
}

export function pimConfigurato(config: Config): boolean {
  return !!config.PIM_DB_URL
}

export interface ProdottoTrovato {
  sku: string
  nome: string | null
  marchio: string | null
  famiglia: string | null
  categoria: string | null
  in_breve: string | null
}

export async function cercaProdottiPim(
  config: Config,
  testo: string,
  famiglia: string | null,
  limite = 5,
): Promise<ProdottoTrovato[]> {
  const [riga] = await pim(config)<{ r: ProdottoTrovato[] | null }[]>`
    select public.assistenza_cerca_prodotti(${testo}, ${famiglia}, ${limite}) as r
  `
  return riga?.r ?? []
}

export async function schedaProdottoPim(config: Config, sku: string): Promise<Record<string, unknown> | null> {
  const [riga] = await pim(config)<{ r: Record<string, unknown> | null }[]>`
    select public.assistenza_scheda_prodotto(${sku}) as r
  `
  return riga?.r ?? null
}

export async function problemiProdottoPim(config: Config, sku: string): Promise<unknown[]> {
  const [riga] = await pim(config)<{ r: unknown[] | null }[]>`
    select public.assistenza_problemi_prodotto(${sku}) as r
  `
  return riga?.r ?? []
}

export async function famigliePim(config: Config): Promise<unknown[]> {
  const [riga] = await pim(config)<{ r: unknown[] | null }[]>`
    select public.assistenza_famiglie() as r
  `
  return riga?.r ?? []
}

/** Per i test: sostituisce il client con uno finto. */
export function impostaClientPimPerTest(finto: ClientPim | null): void {
  client = finto
}
