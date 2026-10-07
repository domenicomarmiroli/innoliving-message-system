/**
 * Un solo contratto, più provider dietro. Aggiungerne uno nuovo domani
 * è implementare questa interfaccia, non riscrivere draft.ts — stesso
 * principio già usato per i canali (channel_account) e per gli allegati
 * per canale.
 */

export interface RichiestaCompletamento {
  sistema: string
  utente: string
  /** Tetto sui token di output: contiene il costo, non solo la lunghezza. */
  max_token: number
}

export interface EsitoCompletamento {
  testo: string
  modello: string
  /** Facoltativi: un provider che non li conosce non li riporta. */
  token_in?: number
  token_out?: number
  /** True se la risposta si è fermata al limite `max_token`: è incompleta. */
  troncata?: boolean
}

/** Chi chiama e se è un lavoro in background (soggetto al tetto giornaliero). */
export interface UsoProvider {
  funzione: string
  sfondo: boolean
}

export interface ProviderAI {
  nome: string
  completa(richiesta: RichiestaCompletamento): Promise<EsitoCompletamento>
}

/**
 * Da chiamare da chi ha bisogno di generare testo — mai istanziare i
 * provider a mano altrove. `modelloOverride` serve a chi ha bisogno di un
 * modello diverso da quello delle bozze (es. la classificazione
 * dell'intento, economica e ad alto volume): stesso provider e stessa
 * chiave, solo il nome del modello cambia.
 */
export async function creaProvider(
  config: {
    AI_PROVIDER: string
    ANTHROPIC_API_KEY?: string
    ANTHROPIC_MODEL: string
  },
  modelloOverride?: string,
  uso?: UsoProvider,
): Promise<ProviderAI> {
  if (config.AI_PROVIDER !== 'anthropic') throw new Error(`Provider AI sconosciuto: ${config.AI_PROVIDER}`)
  if (!config.ANTHROPIC_API_KEY) {
    throw new Error('ANTHROPIC_API_KEY non configurata: le bozze AI non possono generare testo.')
  }
  const { ProviderAnthropic } = await import('./anthropic.js')
  const base = new ProviderAnthropic(config.ANTHROPIC_API_KEY, modelloOverride ?? config.ANTHROPIC_MODEL)
  return conMisura(base, uso ?? { funzione: 'non_indicata', sfondo: false })
}

/**
 * Ogni chiamata passa da qui: tetto giornaliero per i lavori in
 * background, e una riga in `ai_uso` dopo (vedi `consumo.ts`). Nessun
 * chiamante può dimenticarlo, perché nessuno istanzia i provider a mano.
 */
function conMisura(base: ProviderAI, uso: UsoProvider): ProviderAI {
  return {
    nome: base.nome,
    async completa(richiesta) {
      const { controllaBudget, registraChiamata } = await import('./consumo.js')
      if (uso.sfondo) await controllaBudget()
      const esito = await base.completa(richiesta)
      await registraChiamata({
        funzione: uso.funzione,
        modello: esito.modello,
        token_in: esito.token_in ?? 0,
        token_out: esito.token_out ?? 0,
        troncata: esito.troncata ?? false,
      })
      return esito
    },
  }
}
