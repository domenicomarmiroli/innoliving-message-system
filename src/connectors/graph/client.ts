import type { Config } from '../../config.js'
import type { Logger } from '../../logger.js'

/**
 * Client HTTP per Microsoft Graph, con il token preso da solo.
 *
 * Autenticazione **client credentials**: l'app parla per conto proprio,
 * non per conto di un utente che ha fatto login. È l'unica forma
 * possibile per un servizio che gira senza nessuno davanti — ed è il
 * motivo per cui i permessi vanno concessi come *Application* con
 * consenso amministratore, non come *Delegated*.
 *
 * Nessun SDK: una `fetch` basta, coerente con Storage, Mirakl e il resto
 * del progetto. `@azure/identity` porterebbe dietro mezzo Azure per fare
 * una POST con quattro campi.
 */

const AUTORITA = 'https://login.microsoftonline.com'
const GRAPH = 'https://graph.microsoft.com/v1.0'
const TENTATIVI = 3
const ATTESA_BASE_MS = 1000
/** Margine sul token: si rinnova prima della scadenza vera. */
const MARGINE_MS = 60_000

export class ErroreGraph extends Error {
  constructor(
    message: string,
    readonly stato: number,
    readonly corpo: string,
  ) {
    super(message)
    this.name = 'ErroreGraph'
  }
}

export function credenzialiGraphMancanti(config: Config): string[] {
  const richieste = ['MS_TENANT_ID', 'MS_CLIENT_ID', 'MS_CLIENT_SECRET', 'MS_MAILBOX'] as const
  return richieste.filter((k) => !config[k])
}

export function graphConfigurato(config: Config): boolean {
  return credenzialiGraphMancanti(config).length === 0
}

interface TokenInCache {
  valore: string
  scade: number
}

export class ClientGraph {
  private token: TokenInCache | null = null

  constructor(
    private readonly config: Config,
    private readonly log: Logger,
  ) {}

  /** La casella su cui operiamo: ogni richiesta passa da /users/{casella}. */
  get casella(): string {
    return this.config.MS_MAILBOX!
  }

  /**
   * Token applicativo, tenuto in memoria finché vale. Dura circa un'ora
   * e si rinnova da solo: non c'è niente da salvare su disco, e un
   * riavvio ne chiede semplicemente uno nuovo.
   */
  async accessToken(): Promise<string> {
    if (this.token && Date.now() < this.token.scade) return this.token.valore

    const mancanti = credenzialiGraphMancanti(this.config)
    if (mancanti.length > 0) {
      throw new Error(`Graph non configurato: mancano ${mancanti.join(', ')}. Vedi .env.example.`)
    }

    const url = `${AUTORITA}/${encodeURIComponent(this.config.MS_TENANT_ID!)}/oauth2/v2.0/token`
    const corpo = new URLSearchParams({
      client_id: this.config.MS_CLIENT_ID!,
      client_secret: this.config.MS_CLIENT_SECRET!,
      // `.default` = "tutti i permessi applicazione già concessi a questa
      // app": lo scope non si chiede qui, si configura una volta nella
      // registrazione e lo approva un amministratore.
      scope: 'https://graph.microsoft.com/.default',
      grant_type: 'client_credentials',
    })

    const risposta = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: corpo.toString(),
    })
    const testo = await risposta.text()

    if (!risposta.ok) {
      throw new ErroreGraph(messaggioToken(risposta.status, testo), risposta.status, testo)
    }

    const dati = JSON.parse(testo) as { access_token?: string; expires_in?: number }
    if (!dati.access_token) {
      throw new ErroreGraph('Microsoft non ha restituito un access_token.', risposta.status, testo)
    }

    this.token = {
      valore: dati.access_token,
      scade: Date.now() + Math.max((dati.expires_in ?? 3600) * 1000 - MARGINE_MS, 30_000),
    }
    return this.token.valore
  }

  async get<T>(percorso: string, parametri: Record<string, string | undefined> = {}): Promise<T> {
    const risposta = await this.richiedi(this.url(percorso, parametri), { method: 'GET' })
    return this.json<T>(risposta)
  }

  /** Come `get`, ma per un URL già completo: i `@odata.nextLink` della paginazione. */
  async getUrl<T>(url: string): Promise<T> {
    const risposta = await this.richiedi(url, { method: 'GET' })
    return this.json<T>(risposta)
  }

  /** Byte grezzi: il MIME originale di un messaggio (`/$value`). */
  async getBinario(percorso: string): Promise<Buffer> {
    const risposta = await this.richiedi(this.url(percorso, {}), {
      method: 'GET',
      headers: { Accept: '*/*' },
    })
    return Buffer.from(await risposta.arrayBuffer())
  }

  async post(percorso: string, corpo: string, contentType: string): Promise<void> {
    await this.richiedi(this.url(percorso, {}), {
      method: 'POST',
      headers: { 'Content-Type': contentType },
      body: corpo,
    })
  }

  private async json<T>(risposta: Response): Promise<T> {
    const testo = await risposta.text()
    return (testo.trim() === '' ? {} : JSON.parse(testo)) as T
  }

  private url(percorso: string, parametri: Record<string, string | undefined>): string {
    const url = new URL(`${GRAPH}${percorso}`)
    for (const [k, v] of Object.entries(parametri)) {
      if (v !== undefined && v !== '') url.searchParams.set(k, v)
    }
    return url.toString()
  }

  private async richiedi(url: string, init: RequestInit): Promise<Response> {
    let ultimoErrore: unknown = null

    for (let tentativo = 1; tentativo <= TENTATIVI; tentativo += 1) {
      const token = await this.accessToken()
      let risposta: Response
      try {
        risposta = await fetch(url, {
          ...init,
          headers: {
            Accept: 'application/json',
            ...(init.headers ?? {}),
            Authorization: `Bearer ${token}`,
          },
        })
      } catch (errore) {
        ultimoErrore = errore
        await attendi(ATTESA_BASE_MS * 2 ** (tentativo - 1))
        continue
      }

      if (risposta.ok) return risposta

      const corpo = await risposta.text()

      // 401 con un token che credevamo valido: può essere un token
      // revocato prima della scadenza. Si butta la cache e si riprova —
      // ma se è un permesso mancante il tentativo dopo fallisce uguale,
      // e il messaggio d'errore lo dice.
      if (risposta.status === 401 && tentativo < TENTATIVI) {
        this.token = null
        continue
      }

      const temporaneo = risposta.status === 429 || risposta.status >= 500
      if (!temporaneo || tentativo === TENTATIVI) {
        throw new ErroreGraph(messaggioChiaro(risposta.status, corpo), risposta.status, corpo)
      }

      const attesaHeader = risposta.headers.get('Retry-After')
      const ms = attesaHeader ? Number(attesaHeader) * 1000 : ATTESA_BASE_MS * 2 ** (tentativo - 1)
      this.log.warn({ stato: risposta.status, attesa_ms: ms }, 'Graph ha chiesto di rallentare')
      await attendi(ms)
    }

    throw new ErroreGraph(
      `Microsoft Graph non risponde dopo ${TENTATIVI} tentativi: ` +
        `${ultimoErrore instanceof Error ? ultimoErrore.message : String(ultimoErrore)}`,
      0,
      '',
    )
  }
}

/**
 * Errori che dicono cosa fare. I due casi veri di un'integrazione appena
 * configurata sono il consenso mancante e la ApplicationAccessPolicy che
 * esclude la casella: rispondono entrambi 403 e, letti grezzi, sembrano
 * lo stesso problema.
 */
export function messaggioChiaro(stato: number, corpo: string): string {
  if (stato === 401) {
    return (
      'Graph: token rifiutato (401). Controlla MS_CLIENT_SECRET (scaduto o rigenerato?) ' +
      `e che MS_TENANT_ID e MS_CLIENT_ID siano quelli della registrazione. ${corpo.slice(0, 200)}`
    )
  }
  if (stato === 403) {
    return (
      'Graph: accesso negato (403). Di solito è una di due cose: i permessi applicazione ' +
      '(Mail.ReadWrite, Mail.Send) non hanno il consenso amministratore, oppure una ' +
      `ApplicationAccessPolicy esclude questa casella. ${corpo.slice(0, 300)}`
    )
  }
  if (stato === 404) {
    return (
      "Graph: non trovato (404). Controlla MS_MAILBOX: dev'essere l'indirizzo o l'id " +
      `della casella, e la casella deve esistere in questo tenant. ${corpo.slice(0, 200)}`
    )
  }
  return `Graph: richiesta fallita (${stato}): ${corpo.slice(0, 300)}`
}

/**
 * I codici AADSTS sono l'unica parte leggibile della risposta di Entra
 * ID: tradurli qui evita di andarli a cercare quando la casella smette
 * di funzionare.
 */
export function messaggioToken(stato: number, corpo: string): string {
  if (corpo.includes('AADSTS7000215')) {
    return (
      'Graph: client secret non valido (AADSTS7000215). Controlla di aver copiato il ' +
      "*valore* del segreto e non il suo id: nel portale sono due colonne vicine."
    )
  }
  if (corpo.includes('AADSTS7000222')) {
    return (
      'Graph: client secret SCADUTO (AADSTS7000222). Va rigenerato nel portale Azure ' +
      'e aggiornato nelle variabili di Render.'
    )
  }
  if (corpo.includes('AADSTS700016')) {
    return (
      'Graph: applicazione non trovata in questo tenant (AADSTS700016). ' +
      'Controlla MS_CLIENT_ID e MS_TENANT_ID.'
    )
  }
  return `Graph: richiesta del token fallita (${stato}): ${corpo.slice(0, 300)}`
}

function attendi(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms))
}
