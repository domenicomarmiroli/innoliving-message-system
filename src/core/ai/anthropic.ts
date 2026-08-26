import type { EsitoCompletamento, ProviderAI, RichiestaCompletamento } from './provider.js'

/**
 * Provider Claude — chiamata REST diretta, non l'SDK: coerente con il
 * resto del worker (Storage, Mirakl), niente client pesante dove basta
 * una fetch.
 */

const API_URL = 'https://api.anthropic.com/v1/messages'
const VERSIONE_API = '2023-06-01'

export class ProviderAnthropic implements ProviderAI {
  readonly nome = 'anthropic'

  constructor(
    private readonly chiave: string,
    private readonly modello: string,
  ) {}

  async completa(richiesta: RichiestaCompletamento): Promise<EsitoCompletamento> {
    const risposta = await fetch(API_URL, {
      method: 'POST',
      headers: {
        'x-api-key': this.chiave,
        'anthropic-version': VERSIONE_API,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: this.modello,
        max_tokens: richiesta.max_token,
        system: richiesta.sistema,
        messages: [{ role: 'user', content: richiesta.utente }],
      }),
    })

    if (!risposta.ok) {
      const corpo = await risposta.text().catch(() => '')
      throw new Error(`Anthropic ha risposto ${risposta.status}: ${corpo.slice(0, 300)}`)
    }

    const dati = (await risposta.json()) as {
      content?: Array<{ type?: string; text?: string }>
      model?: string
    }
    const testo = (dati.content ?? [])
      .filter((b) => b.type === 'text' && typeof b.text === 'string')
      .map((b) => b.text)
      .join('')
      .trim()

    if (!testo) {
      throw new Error('Anthropic ha risposto senza testo utilizzabile.')
    }

    return { testo, modello: dati.model ?? this.modello }
  }
}
