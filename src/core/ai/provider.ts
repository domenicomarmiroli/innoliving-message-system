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
}

export interface ProviderAI {
  nome: string
  completa(richiesta: RichiestaCompletamento): Promise<EsitoCompletamento>
}

/** Da chiamare da chi ha bisogno di generare testo — mai istanziare i provider a mano altrove. */
export async function creaProvider(config: {
  AI_PROVIDER: string
  ANTHROPIC_API_KEY?: string
  ANTHROPIC_MODEL: string
}): Promise<ProviderAI> {
  if (config.AI_PROVIDER === 'anthropic') {
    if (!config.ANTHROPIC_API_KEY) {
      throw new Error('ANTHROPIC_API_KEY non configurata: le bozze AI non possono generare testo.')
    }
    const { ProviderAnthropic } = await import('./anthropic.js')
    return new ProviderAnthropic(config.ANTHROPIC_API_KEY, config.ANTHROPIC_MODEL)
  }
  throw new Error(`Provider AI sconosciuto: ${config.AI_PROVIDER}`)
}
