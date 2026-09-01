import type { Logger } from '../../logger.js'

/**
 * Client HTTP per una piattaforma Mirakl.
 *
 * Un'istanza per operatore: tutti parlano la stessa API su URL diversi
 * con chiavi diverse. Il codice non sa quali siano né quanti siano: URL
 * e riferimento al segreto arrivano da `channel_account`, la chiave
 * dalle variabili d'ambiente. Aggiungere un operatore è una riga di SQL
 * più una variabile.
 *
 * Autenticazione verificata sul campo, non dedotta dalla documentazione:
 * `Authorization: <chiave>`, senza prefisso `Bearer`. La documentazione
 * pubblica la chiama "Shop-API-Key" e non mostra il formato; una chiamata
 * di prova ha risposto 200 con questa forma.
 */

export interface OperatoreMirakl {
  account_id: string
  code: string
  display_name: string
  endpoint: string
  chiave: string
  /**
   * Facoltativo: solo per un utente Mirakl con accesso a più shop, dove
   * senza indicarlo esplicitamente l'API ne assume uno "di default" che
   * può non essere quello con le conversazioni vere — 200 con data:[],
   * nessun errore. La maggior parte degli operatori non ne ha bisogno.
   */
  shop_id: string | null
}

export class ErroreMirakl extends Error {
  constructor(
    message: string,
    readonly stato: number,
    readonly corpo: string,
  ) {
    super(message)
    this.name = 'ErroreMirakl'
  }
}

const TENTATIVI = 3
const ATTESA_BASE_MS = 1000

/** Toglie la barra finale: evita `//api/...` negli URL costruiti. */
export function normalizzaEndpoint(url: string): string {
  return url.trim().replace(/\/+$/, '')
}

export class ClientMirakl {
  constructor(
    private readonly operatore: OperatoreMirakl,
    private readonly log: Logger,
  ) {}

  get code(): string {
    return this.operatore.code
  }

  async get<T>(percorso: string, parametri: Record<string, string | undefined>): Promise<T> {
    const url = new URL(
      `${normalizzaEndpoint(this.operatore.endpoint)}/api${percorso}`,
    )
    for (const [k, v] of Object.entries(parametri)) {
      if (v !== undefined && v !== '') url.searchParams.set(k, v)
    }
    return this.richiedi<T>(url.toString(), { method: 'GET' })
  }

  async post<T>(percorso: string, corpo: unknown): Promise<T> {
    const url = `${normalizzaEndpoint(this.operatore.endpoint)}/api${percorso}`
    return this.richiedi<T>(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(corpo),
    })
  }

  /**
   * POST multipart/form-data — M12 con allegati. Niente Content-Type
   * manuale: con un corpo FormData, fetch calcola da solo il boundary
   * corretto, e impostarlo a mano lo romperebbe.
   */
  async postMultipart<T>(percorso: string, form: FormData): Promise<T> {
    const url = `${normalizzaEndpoint(this.operatore.endpoint)}/api${percorso}`
    return this.richiedi<T>(url, { method: 'POST', body: form })
  }

  /**
   * Scarica un allegato — M13, `GET /inbox/threads/{attachment_id}/download`.
   * Byte grezzi, non JSON: passa dallo stesso ritentativo di `richiedi`,
   * ma legge il corpo come binario e riporta il Content-Type dichiarato.
   */
  async download(percorso: string): Promise<{ contenuto: Buffer; mime: string | null }> {
    const url = `${normalizzaEndpoint(this.operatore.endpoint)}/api${percorso}`
    const risposta = await this.richiediGrezzo(url, { method: 'GET' })
    const buffer = Buffer.from(await risposta.arrayBuffer())
    return { contenuto: buffer, mime: risposta.headers.get('content-type') }
  }

  private async richiedi<T>(url: string, init: RequestInit): Promise<T> {
    const risposta = await this.richiediGrezzo(url, init)
    const testo = await risposta.text()
    if (testo.trim() === '') return {} as T
    return JSON.parse(testo) as T
  }

  /** Ritentativo ed errori chiari, condivisi fra risposte JSON e binarie. */
  private async richiediGrezzo(url: string, init: RequestInit): Promise<Response> {
    let ultimoErrore: unknown = null

    for (let tentativo = 1; tentativo <= TENTATIVI; tentativo += 1) {
      let risposta: Response
      try {
        risposta = await fetch(url, {
          ...init,
          headers: {
            ...(init.headers ?? {}),
            // Verificato: la chiave nuda, senza Bearer.
            Authorization: this.operatore.chiave,
            Accept: 'application/json',
          },
        })
      } catch (errore) {
        // Rete caduta: si riprova, non è colpa della richiesta.
        ultimoErrore = errore
        await attendi(ATTESA_BASE_MS * 2 ** (tentativo - 1))
        continue
      }

      if (risposta.ok) return risposta

      const corpo = await risposta.text()

      // 429 e 5xx sono temporanei: si riprova. 4xx no — riprovare una
      // chiave sbagliata dieci volte non la fa diventare giusta.
      const temporaneo = risposta.status === 429 || risposta.status >= 500
      if (!temporaneo || tentativo === TENTATIVI) {
        throw new ErroreMirakl(
          messaggioChiaro(risposta.status, this.operatore.code, corpo),
          risposta.status,
          corpo,
        )
      }

      const attesa = risposta.headers.get('Retry-After')
      const ms = attesa
        ? Number(attesa) * 1000
        : ATTESA_BASE_MS * 2 ** (tentativo - 1)
      this.log.warn(
        { operatore: this.operatore.code, stato: risposta.status, attesa_ms: ms },
        'Mirakl ha chiesto di rallentare',
      )
      await attendi(ms)
    }

    throw new ErroreMirakl(
      `Nessuna risposta da ${this.operatore.code} dopo ${TENTATIVI} tentativi: ` +
        `${ultimoErrore instanceof Error ? ultimoErrore.message : String(ultimoErrore)}`,
      0,
      '',
    )
  }
}

/**
 * Messaggi d'errore che dicono cosa fare, non solo cosa è successo.
 * Un 401 alle tre di notte deve spiegarsi da solo.
 */
function messaggioChiaro(stato: number, code: string, corpo: string): string {
  if (stato === 401 || stato === 403) {
    return (
      `${code}: chiave API rifiutata (${stato}). Controlla la variabile indicata da ` +
      `channel_account.secret_ref, e che la chiave non sia stata rigenerata nel back office.`
    )
  }
  if (stato === 404) {
    return (
      `${code}: endpoint inesistente (404). Verifica config.endpoint in channel_account: ` +
      `deve essere l'URL del back office senza /api finale.`
    )
  }
  return `${code}: richiesta fallita (${stato}): ${corpo.slice(0, 300)}`
}

function attendi(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms))
}

/**
 * Gli operatori configurati, con la chiave presa dalle variabili
 * d'ambiente tramite `secret_ref`.
 *
 * Un operatore senza endpoint o senza chiave non è un errore fatale: gli
 * altri devono continuare a funzionare. Viene saltato con un avviso che
 * dice esattamente cosa manca.
 */
export function costruisciOperatori(
  righe: Array<{
    id: string
    code: string
    display_name: string
    config: { endpoint?: unknown; shop_id?: unknown } | null
    secret_ref: string | null
  }>,
  env: NodeJS.ProcessEnv,
  log: Logger,
): OperatoreMirakl[] {
  const pronti: OperatoreMirakl[] = []

  for (const r of righe) {
    const endpoint =
      typeof r.config?.endpoint === 'string' ? r.config.endpoint.trim() : ''
    if (!endpoint) {
      log.warn({ operatore: r.code }, "manca config.endpoint: operatore saltato")
      continue
    }
    if (!r.secret_ref) {
      log.warn({ operatore: r.code }, 'manca secret_ref: operatore saltato')
      continue
    }
    const chiave = env[r.secret_ref]
    if (!chiave) {
      log.warn(
        { operatore: r.code, variabile: r.secret_ref },
        "la variabile d'ambiente indicata da secret_ref non è impostata: operatore saltato",
      )
      continue
    }
    const shopId =
      typeof r.config?.shop_id === 'string' && r.config.shop_id.trim() !== ''
        ? r.config.shop_id.trim()
        : null

    pronti.push({
      account_id: r.id,
      code: r.code,
      display_name: r.display_name,
      endpoint,
      chiave,
      shop_id: shopId,
    })
  }

  return pronti
}
