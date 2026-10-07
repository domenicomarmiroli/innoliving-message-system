import type { Db } from '../../db/index.js'
import type { Logger } from '../../logger.js'

/**
 * Misura e limite di spesa delle chiamate AI (migrazione 0040).
 *
 * Nato da un caso reale (02-07/10): un giro periodico ritraduceva a ogni
 * passaggio quattro newsletter troppo lunghe, per giorni, e nessuno se ne
 * è accorto finché non è arrivato il conto. Due difese:
 *
 *  1. **Ogni chiamata lascia una riga in `ai_uso`**: funzione, modello,
 *     token, costo stimato, e se la risposta è stata troncata. Una
 *     risposta troncata ripetuta è proprio la firma di quel guasto.
 *  2. **Un tetto giornaliero per i lavori in background** (traduzione in
 *     arrivo, classificazione): superato, quei giri si fermano fino a
 *     mezzanotte e resta una riga in `ingest_anomaly`. Le azioni degli
 *     operatori (bozze, traduzione in uscita) NON si bloccano: un
 *     operatore che lavora non deve trovarsi senza strumenti per un guasto
 *     altrui — il loro costo però si conta nel totale.
 *
 * Tetto e prezzi stanno in `app_config.ai_controllo`, modificabili senza
 * deploy. Se la configurazione manca valgono i valori prudenti qui sotto.
 */

export interface PrezzoModello {
  /** Dollari per milione di token. */
  input: number
  output: number
}

export interface ConfigControllo {
  budget_giornaliero_usd: number
  prezzi: Record<string, PrezzoModello>
}

/** Prezzo usato per un modello non elencato: volutamente alto, sovrastima invece di sottostimare. */
const PREZZO_IGNOTO: PrezzoModello = { input: 5, output: 25 }
const CONFIG_PREDEFINITA: ConfigControllo = { budget_giornaliero_usd: 5, prezzi: {} }

/** Il prezzo del modello: corrispondenza esatta, poi per prefisso (gli id con data, es. `-20251001`). */
export function prezzoDi(conf: ConfigControllo, modello: string): PrezzoModello {
  if (conf.prezzi[modello]) return conf.prezzi[modello]!
  const chiave = Object.keys(conf.prezzi)
    .sort((a, b) => b.length - a.length)
    .find((k) => modello.startsWith(k))
  return chiave ? conf.prezzi[chiave]! : PREZZO_IGNOTO
}

export function costoStimato(conf: ConfigControllo, modello: string, tokenIn: number, tokenOut: number): number {
  const p = prezzoDi(conf, modello)
  return (tokenIn * p.input + tokenOut * p.output) / 1_000_000
}

/** Il giorno di calendario italiano: il tetto si azzera a mezzanotte di qui, non di UTC. */
export function giornoItaliano(d: Date = new Date()): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Rome' }).format(d)
}

export class BudgetAISuperato extends Error {
  constructor(speso: number, tetto: number) {
    super(`Tetto giornaliero AI raggiunto (${speso.toFixed(2)} $ su ${tetto.toFixed(2)} $): lavori in background sospesi fino a mezzanotte.`)
    this.name = 'BudgetAISuperato'
  }
}

// ---------------------------------------------------------------------
// Stato del processo
// ---------------------------------------------------------------------

let misura: { db: Db; log: Logger } | null = null
let cacheConfig: { valore: ConfigControllo; letto: number } | null = null
let cacheSpesa: { giorno: string; valore: number; letto: number } | null = null
let avvisoGiorno: string | null = null

const VALIDITA_CACHE_MS = 60_000

/** Da chiamare all'avvio del server. Senza, le chiamate AI non vengono misurate (es. nei test). */
export function impostaMisuraAI(db: Db, log: Logger): void {
  misura = { db, log }
}

/** Per i test. */
export function azzeraMisuraAI(): void {
  misura = null
  cacheConfig = null
  cacheSpesa = null
  avvisoGiorno = null
}

export function misuraAttiva(): boolean {
  return misura !== null
}

async function configurazione(db: Db): Promise<ConfigControllo> {
  if (cacheConfig && Date.now() - cacheConfig.letto < VALIDITA_CACHE_MS) return cacheConfig.valore
  const [riga] = await db<{ value: Partial<ConfigControllo> }[]>`
    select value from app_config where key = 'ai_controllo'
  `
  const valore: ConfigControllo = {
    budget_giornaliero_usd: Number(riga?.value?.budget_giornaliero_usd ?? CONFIG_PREDEFINITA.budget_giornaliero_usd),
    prezzi: riga?.value?.prezzi ?? CONFIG_PREDEFINITA.prezzi,
  }
  cacheConfig = { valore, letto: Date.now() }
  return valore
}

async function spesaDiOggi(db: Db): Promise<number> {
  const giorno = giornoItaliano()
  if (cacheSpesa && cacheSpesa.giorno === giorno && Date.now() - cacheSpesa.letto < VALIDITA_CACHE_MS) {
    return cacheSpesa.valore
  }
  const [riga] = await db<{ totale: string | null }[]>`
    select sum(costo_usd)::text as totale from ai_uso
    where (created_at at time zone 'Europe/Rome')::date = ${giorno}::date
  `
  const valore = Number(riga?.totale ?? 0)
  cacheSpesa = { giorno, valore, letto: Date.now() }
  return valore
}

/**
 * Prima di una chiamata in background: lancia `BudgetAISuperato` se il
 * tetto di oggi è raggiunto. La prima volta del giorno lascia una riga in
 * `ingest_anomaly` (regola 5): un tetto raggiunto è un segnale da
 * guardare, quasi sempre un giro che si ripete.
 */
export async function controllaBudget(): Promise<void> {
  if (!misura) return
  const { db, log } = misura
  let conf: ConfigControllo
  let speso: number
  try {
    conf = await configurazione(db)
    speso = await spesaDiOggi(db)
  } catch (errore) {
    // Tabella non ancora creata (migrazione 0040) o database lento: non si
    // ferma il lavoro per un controllo che non si riesce a fare.
    log.warn({ err: errore instanceof Error ? errore.message : String(errore) }, 'controllo del tetto AI non riuscito')
    return
  }
  if (speso < conf.budget_giornaliero_usd) return

  const giorno = giornoItaliano()
  if (avvisoGiorno !== giorno) {
    avvisoGiorno = giorno
    log.error({ speso, tetto: conf.budget_giornaliero_usd }, 'tetto giornaliero AI raggiunto: lavori in background sospesi')
    try {
      await db`
        insert into ingest_anomaly (tipo, payload)
        values ('ai_budget_superato', ${db.json({ giorno, speso_usd: speso, tetto_usd: conf.budget_giornaliero_usd })})
      `
    } catch {
      // Il blocco vale comunque: l'anomalia è un avviso, non la difesa.
    }
  }
  throw new BudgetAISuperato(speso, conf.budget_giornaliero_usd)
}

export interface ChiamataMisurata {
  funzione: string
  modello: string
  token_in: number
  token_out: number
  troncata: boolean
}

/** Dopo una chiamata: una riga in `ai_uso`. Un errore qui non fa mai fallire il lavoro già fatto. */
export async function registraChiamata(c: ChiamataMisurata): Promise<void> {
  if (!misura) return
  const { db, log } = misura
  try {
    const conf = await configurazione(db)
    const costo = costoStimato(conf, c.modello, c.token_in, c.token_out)
    await db`
      insert into ai_uso (funzione, modello, token_in, token_out, costo_usd, troncata)
      values (${c.funzione}, ${c.modello}, ${c.token_in}, ${c.token_out}, ${costo}, ${c.troncata})
    `
    if (cacheSpesa && cacheSpesa.giorno === giornoItaliano()) cacheSpesa.valore += costo
    if (c.troncata) {
      log.warn({ funzione: c.funzione, modello: c.modello, token_out: c.token_out }, 'risposta AI troncata al limite di token')
    }
  } catch (errore) {
    log.warn({ err: errore instanceof Error ? errore.message : String(errore) }, 'registrazione del consumo AI fallita')
  }
}
