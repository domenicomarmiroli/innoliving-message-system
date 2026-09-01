import type { Config } from '../../config.js'
import type { Db } from '../../db/index.js'
import type { Logger } from '../../logger.js'
import { ClientMirakl, costruisciOperatori, type OperatoreMirakl } from './client.js'
import { normalizzaRisposta, type EsitoNormalizza } from './normalize.js'
import { upsertThread } from './upsert.js'

/**
 * Sincronizzazione dei messaggi Mirakl, operatore per operatore.
 *
 * A differenza di Amazon qui c'è una vera API: si chiede cosa è
 * cambiato da un certo istante (`updated_since`) e si scorre a cursore.
 * Il segnalibro sta in `sync_state.api_cursor`.
 *
 * La finestra si arretra di qualche minuto rispetto all'ultimo giro:
 * fra il momento in cui leggiamo e quello in cui salviamo passa del
 * tempo, e un thread aggiornato in quell'intervallo andrebbe perso per
 * sempre. Ripassare qualche thread già visto non costa niente — la
 * scrittura è idempotente — mentre perderne uno costa un cliente.
 */

const SOVRAPPOSIZIONE_MS = 5 * 60_000
const PAGINE_MAX = 50
const LIMITE_PAGINA = '50'

export interface EsitoSyncOperatore {
  operatore: string
  thread_visti: number
  thread_nuovi: number
  messaggi_inseriti: number
  agganciati: number
  stranezze: number
  errore: string | null
}

interface RispostaM11 {
  data?: unknown
  next_page_token?: unknown
}

export async function sincronizzaMirakl(
  db: Db,
  log: Logger,
  config: Config,
  env: NodeJS.ProcessEnv = process.env,
): Promise<EsitoSyncOperatore[]> {
  const righe = await db<
    {
      id: string
      code: string
      display_name: string
      config: { endpoint?: unknown } | null
      secret_ref: string | null
    }[]
  >`
    select id, code, display_name, config, secret_ref
    from channel_account
    where kind = 'mirakl' and active
    order by code
  `

  const operatori = costruisciOperatori(righe, env, log)
  if (operatori.length === 0) {
    log.info({}, 'nessun operatore Mirakl configurato: sincronizzazione saltata')
    return []
  }

  const giorniCoda = await leggiGiorniCoda(db)
  const esiti: EsitoSyncOperatore[] = []

  // In sequenza, non in parallelo: sono due o tre operatori e ognuno ha
  // i suoi limiti di frequenza. Il parallelismo qui comprerebbe secondi
  // e venderebbe 429.
  for (const op of operatori) {
    esiti.push(await sincronizzaOperatore(db, log, config, op, giorniCoda))
  }

  return esiti
}

async function sincronizzaOperatore(
  db: Db,
  log: Logger,
  config: Config,
  operatore: OperatoreMirakl,
  giorniCoda: number,
): Promise<EsitoSyncOperatore> {
  const esito: EsitoSyncOperatore = {
    operatore: operatore.code,
    thread_visti: 0,
    thread_nuovi: 0,
    messaggi_inseriti: 0,
    agganciati: 0,
    stranezze: 0,
    errore: null,
  }

  const client = new ClientMirakl(operatore, log)
  const inizioGiro = new Date()

  try {
    const da = await leggiSegnalibro(db, operatore.account_id)
    let token: string | undefined
    let pagina = 0

    do {
      // Nessun entity_type nel filtro: il normalizzatore accetta sia
      // MMP_ORDER sia MPS_ORDER (normalize.ts, ENTITA_ORDINE) perché non
      // tutti gli operatori Mirakl chiamano l'entità ordine allo stesso
      // modo, e Mirakl stesso consiglia di non passare entity_type senza
      // un entity_id specifico (rischio di 400 o risultati inattesi).
      // shop_id invece VA passato quando configurato: un utente Mirakl
      // con accesso a più shop, senza shop_id esplicito, interroga lo
      // shop "di default" — che può essere un altro, e restituisce 200
      // con data:[] anche se lo shop giusto ha conversazioni reali.
      // Confermato dal supporto di un secondo operatore (01/09) dopo che
      // la connessione risultava sana ma senza mai un solo thread.
      const risposta = await client.get<RispostaM11>('/inbox/threads', {
        shop_id: operatore.shop_id ?? undefined,
        updated_since: da ?? undefined,
        with_messages: 'true',
        limit: LIMITE_PAGINA,
        page_token: token,
      })

      const norm = normalizzaRisposta(risposta)
      await registraStranezze(db, operatore, norm)
      esito.stranezze += norm.stranezze.length

      for (const t of norm.threads) {
        const r = await upsertThread(db, log, config, operatore, t, giorniCoda)
        esito.thread_visti += 1
        if (r.nuovo) esito.thread_nuovi += 1
        if (r.agganciato) esito.agganciati += 1
        esito.messaggi_inseriti += r.messaggi_inseriti
      }

      token =
        typeof risposta.next_page_token === 'string' && risposta.next_page_token
          ? risposta.next_page_token
          : undefined
      pagina += 1

      if (pagina >= PAGINE_MAX && token) {
        // Non proseguiamo all'infinito, ma nemmeno tacciamo: un limite
        // silenzioso si legge come "ho finito" quando non è vero.
        log.warn(
          { operatore: operatore.code, pagine: pagina },
          'raggiunto il limite di pagine: il resto al prossimo giro',
        )
        break
      }
    } while (token)

    // Il segnalibro si sposta solo se il giro è andato a buon fine, e
    // arretrato della sovrapposizione.
    await salvaSegnalibro(
      db,
      operatore.account_id,
      new Date(inizioGiro.getTime() - SOVRAPPOSIZIONE_MS),
      null,
    )
  } catch (errore) {
    esito.errore = errore instanceof Error ? errore.message : String(errore)
    await salvaSegnalibro(db, operatore.account_id, null, esito.errore)
    log.error({ operatore: operatore.code, err: esito.errore }, 'sincronizzazione Mirakl fallita')
  }

  return esito
}

// ---------------------------------------------------------------------

async function leggiSegnalibro(db: Db, accountId: string): Promise<string | null> {
  const [riga] = await db<{ api_cursor: string | null }[]>`
    select api_cursor from sync_state where account_id = ${accountId}
  `
  return riga?.api_cursor ?? null
}

async function salvaSegnalibro(
  db: Db,
  accountId: string,
  quando: Date | null,
  errore: string | null,
): Promise<void> {
  await db`
    insert into sync_state (
      account_id, api_cursor, last_ok_at, last_error, consecutive_failures
    ) values (
      ${accountId}, ${quando ? quando.toISOString() : null},
      ${errore ? null : new Date()}, ${errore}, ${errore ? 1 : 0}
    )
    on conflict (account_id) do update set
      api_cursor = coalesce(excluded.api_cursor, sync_state.api_cursor),
      last_ok_at = coalesce(excluded.last_ok_at, sync_state.last_ok_at),
      last_error = excluded.last_error,
      consecutive_failures = case
        when excluded.last_error is null then 0
        else sync_state.consecutive_failures + 1
      end,
      updated_at = now()
  `
}

async function leggiGiorniCoda(db: Db): Promise<number> {
  const [riga] = await db<{ value: { giorni_coda?: unknown } }[]>`
    select value from app_config where key = 'mail_ingest'
  `
  const v = riga?.value?.giorni_coda
  return typeof v === 'number' && v >= 0 ? v : 7
}

/**
 * Le stranezze non si perdono (regola 5).
 *
 * Questo connettore è scritto sulla documentazione e non su risposte
 * vere: la prima conversazione reale dirà se i nomi dei campi
 * corrispondono, e lo dirà QUI. Guardare `ingest_anomaly` dopo il primo
 * messaggio è il collaudo vero di tutto il modulo.
 */
async function registraStranezze(
  db: Db,
  operatore: OperatoreMirakl,
  norm: EsitoNormalizza,
): Promise<void> {
  for (const s of norm.stranezze) {
    try {
      await db`
        insert into ingest_anomaly (account_id, tipo, payload)
        values (${operatore.account_id}, ${s.tipo}, ${db.json(s.dettaglio as never)})
      `
    } catch {
      /* se il database non risponde se ne accorge il chiamante */
    }
  }
}
