import type { Config } from '../../config.js'
import type { Db } from '../../db/index.js'
import type { Logger } from '../../logger.js'
import {
  conta,
  contatoriVuoti,
  elaboraEmail,
  type ContatoriGenere,
} from '../mail/elabora.js'
import { analizza } from '../mail/parse.js'
import { caricaRegole } from '../mail/regole.js'
import { ClientGraph, credenzialiGraphMancanti } from './client.js'

/**
 * Lettura della casella Microsoft 365 via Graph.
 *
 * **Scarica il MIME originale** (`/messages/{id}/$value`) invece di
 * leggere i campi JSON del messaggio. Sembra la strada lunga ed è
 * invece quella corta: così `parse.ts` (mailparser) riceve esattamente
 * ciò che riceve da IMAP, e tutto il resto — riconoscimento del canale,
 * header `X-Space-Notification-Type` di Amazon, catena In-Reply-To,
 * allegati, resi, rimborsi, reclami — funziona senza una riga di codice
 * in più. La versione JSON di Graph normalizza gli header e perderemmo
 * proprio quelli su cui si regge la classificazione.
 *
 * Il segnalibro è una **data** (`receivedDateTime`), non un id: Graph
 * non ha niente come l'UID di IMAP, e il `delta` avrebbe bisogno di un
 * token che scade e va salvato. La data, arretrata di qualche minuto ad
 * ogni giro, ripassa qualche messaggio già visto — e non è un problema,
 * perché il vincolo unique sul Message-ID lo scarta. Lo stesso
 * compromesso già fatto per Mirakl, per lo stesso motivo: ripassare
 * costa niente, perdere un messaggio costa un cliente.
 */

/** Quanto si arretra la finestra ad ogni giro. */
const SOVRAPPOSIZIONE_MS = 5 * 60_000
/** Messaggi per pagina. Graph ne concede fino a 1000, ma qui contano i MIME da scaricare. */
const PER_PAGINA = '25'
/** Pagine massime per giro: un arretrato enorme si smaltisce in più giri, non in uno. */
const PAGINE_MAX = 20
/**
 * Da quando leggere la primissima volta. Senza un limite, il primo giro
 * su una casella con anni di storico importerebbe tutto: non è un
 * disastro (le email vecchie entrano già chiuse, vedi `giorni_coda`) ma
 * è un'ora di lavoro inutile e centinaia di chiamate AI di
 * classificazione. Si parte da ieri e si guarda cosa succede.
 */
const PRIMO_GIRO_GIORNI = 1

export interface EsitoGraph extends ContatoriGenere {
  lette: number
  errori: number
  /** Fin dove siamo arrivati: la stessa data che ripartirà al giro dopo. */
  segnalibro: string | null
}

interface MessaggioLista {
  id?: unknown
  receivedDateTime?: unknown
}

interface RispostaLista {
  value?: unknown
  '@odata.nextLink'?: unknown
}

export async function leggiCasellaGraph(
  db: Db,
  log: Logger,
  config: Config,
): Promise<EsitoGraph> {
  const mancanti = credenzialiGraphMancanti(config)
  if (mancanti.length > 0) {
    throw new Error(
      `Casella Microsoft non configurata: mancano ${mancanti.join(', ')}. Vedi .env.example.`,
    )
  }

  const contesto = await caricaRegole(db, 'graph')
  const { casella } = contesto
  const client = new ClientGraph(config, log)

  const inizioGiro = new Date()
  const da = (await leggiSegnalibro(db, casella.account_id)) ?? predefinito()

  const esito: EsitoGraph = {
    lette: 0,
    ...contatoriVuoti(),
    errori: 0,
    segnalibro: da,
  }

  try {
    // La cartella è sempre "inbox" (nome noto di Graph), non
    // MAIL_FOLDER: quella variabile descrive la casella Gmail, e usarla
    // qui legherebbe due caselle indipendenti alla stessa impostazione.
    let url: string | null = null
    let pagina = 0

    do {
      const risposta: RispostaLista = url
        ? await client.getUrl<RispostaLista>(url)
        : await client.get<RispostaLista>(
            `/users/${encodeURIComponent(client.casella)}/mailFolders/inbox/messages`,
            {
              $filter: `receivedDateTime ge ${da}`,
              $select: 'id,receivedDateTime',
              $orderby: 'receivedDateTime asc',
              $top: PER_PAGINA,
            },
          )

      const messaggi = Array.isArray(risposta.value) ? (risposta.value as MessaggioLista[]) : []

      for (const m of messaggi) {
        const id = typeof m.id === 'string' ? m.id : null
        if (!id) continue
        esito.lette += 1

        try {
          const mime = await client.getBinario(
            `/users/${encodeURIComponent(client.casella)}/messages/${encodeURIComponent(id)}/$value`,
          )
          // `uid` è null: è un identificativo IMAP e qui non esiste. Il
          // messaggio si identifica dal suo Message-ID, come sempre.
          const email = { ...(await analizza(mime, null)), casella: 'graph' as const }
          conta(esito, await elaboraEmail(db, log, config, email, contesto))
        } catch (errore) {
          esito.errori += 1
          // Regola 5: quello che fallisce finisce in ingest_anomaly con
          // abbastanza contesto per ritrovarlo, non solo in un log.
          await registraAnomalia(db, casella.account_id, id, errore)
          log.error(
            { graph_id: id, err: messaggioErrore(errore) },
            'email Microsoft non elaborata',
          )
        }
      }

      url = typeof risposta['@odata.nextLink'] === 'string' ? risposta['@odata.nextLink'] : null
      pagina += 1

      if (pagina >= PAGINE_MAX && url) {
        // Un limite silenzioso si legge come "ho finito" quando non è vero.
        log.warn({ pagine: pagina }, 'Graph: limite di pagine raggiunto, il resto al giro dopo')
        break
      }
    } while (url)

    // Il segnalibro si sposta solo se il giro è andato a buon fine, e
    // arretrato: fra il momento in cui leggiamo e quello in cui
    // salviamo passa del tempo, e un messaggio arrivato in mezzo
    // andrebbe perso per sempre.
    esito.segnalibro = new Date(inizioGiro.getTime() - SOVRAPPOSIZIONE_MS).toISOString()
    await salvaStato(db, casella.account_id, esito.segnalibro, null)
  } catch (errore) {
    await salvaStato(db, casella.account_id, null, messaggioErrore(errore))
    throw errore
  }

  return esito
}

function predefinito(): string {
  return new Date(Date.now() - PRIMO_GIRO_GIORNI * 86_400_000).toISOString()
}

async function leggiSegnalibro(db: Db, accountId: string): Promise<string | null> {
  const [riga] = await db<{ api_cursor: string | null }[]>`
    select api_cursor from sync_state where account_id = ${accountId}
  `
  return riga?.api_cursor ?? null
}

async function salvaStato(
  db: Db,
  accountId: string,
  segnalibro: string | null,
  errore: string | null,
): Promise<void> {
  await db`
    insert into sync_state (
      account_id, api_cursor, last_ok_at, last_error, consecutive_failures
    ) values (
      ${accountId}, ${segnalibro}, ${errore ? null : new Date()}, ${errore}, ${errore ? 1 : 0}
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

async function registraAnomalia(
  db: Db,
  accountId: string,
  graphId: string,
  errore: unknown,
): Promise<void> {
  try {
    await db`
      insert into ingest_anomaly (account_id, tipo, payload)
      values (${accountId}, 'email_graph_non_elaborata', ${db.json({
        graph_id: graphId,
        errore: messaggioErrore(errore),
      })})
    `
  } catch {
    // Se non riusciamo nemmeno a registrare l'anomalia il database è
    // irraggiungibile: il ciclo fallirà comunque poco dopo.
  }
}

function messaggioErrore(e: unknown): string {
  return e instanceof Error ? e.message : String(e)
}
