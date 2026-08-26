import { ImapFlow } from 'imapflow'

import type { Config } from '../../config.js'
import type { Db } from '../../db/index.js'
import type { Logger } from '../../logger.js'
import { aggancia } from './aggancia.js'
import { analizza } from './parse.js'
import { caricaRegole } from './regole.js'
import { registraNotifica } from './notifica.js'
import { classificaMittente, riconosci } from './riconosci.js'
import { upsertEmail } from './upsert.js'

/**
 * Lettura della casella via IMAP.
 *
 * Riprende dall'ultimo UID salvato in sync_state, così un riavvio non
 * rilegge tutto e soprattutto non perde niente. Il vincolo unique sul
 * Message-ID resta comunque l'ultima difesa: anche rileggendo, i
 * messaggi non si duplicano.
 *
 * Su UIDVALIDITY: se il server la cambia, gli UID precedenti non valgono
 * più. In quel caso ripartiamo da zero e lasciamo che sia il vincolo sul
 * Message-ID a scartare i già visti — è lento una volta, ma è corretto.
 */

export interface EsitoCiclo {
  lette: number
  inserite: number
  gia_presenti: number
  /** Scartate perché il mittente è in `domini_esclusi`. */
  ignorate: number
  /** Avvisi di mancata consegna, annotati sulla conversazione. */
  notifiche: number
  errori: number
  ultimo_uid: number | null
}

interface StatoSync {
  imap_uid: number | null
  uidvalidity: number | null
}

export function credenzialiMancanti(config: Config): string[] {
  const richieste = ['MAIL_IMAP_HOST', 'MAIL_USER', 'MAIL_PASSWORD'] as const
  return richieste.filter((k) => !config[k])
}

export async function leggiCasella(
  db: Db,
  log: Logger,
  config: Config,
): Promise<EsitoCiclo> {
  const mancanti = credenzialiMancanti(config)
  if (mancanti.length > 0) {
    throw new Error(
      `Casella non configurata: mancano ${mancanti.join(', ')}. Vedi .env.example.`,
    )
  }

  const { regole, casella, opzioni } = await caricaRegole(db)
  const stato = await leggiStato(db, casella.account_id)

  const client = new ImapFlow({
    host: config.MAIL_IMAP_HOST!,
    port: config.MAIL_IMAP_PORT,
    secure: true,
    auth: { user: config.MAIL_USER!, pass: config.MAIL_PASSWORD! },
    // Il logger di ImapFlow stampa il traffico IMAP, che contiene i
    // messaggi dei clienti. Fuori dai log (regola 8).
    logger: false,
  })

  const esito: EsitoCiclo = {
    lette: 0,
    inserite: 0,
    gia_presenti: 0,
    ignorate: 0,
    notifiche: 0,
    errori: 0,
    ultimo_uid: stato.imap_uid,
  }

  try {
    await client.connect()
    const cartella = await client.mailboxOpen(config.MAIL_FOLDER)

    const uidvalidity = Number(cartella.uidValidity)
    const ripartiDaZero =
      stato.uidvalidity !== null && stato.uidvalidity !== uidvalidity

    if (ripartiDaZero) {
      log.warn(
        { prima: stato.uidvalidity, ora: uidvalidity },
        'UIDVALIDITY cambiata: gli UID salvati non valgono più, si rilegge tutto',
      )
    }

    const daUid = ripartiDaZero || stato.imap_uid === null ? 1 : stato.imap_uid + 1
    let maxUid = stato.imap_uid ?? 0

    for await (const msg of client.fetch(
      { uid: `${daUid}:*` },
      { uid: true, source: true },
      { uid: true },
    )) {
      // `uid:"n:*"` restituisce sempre almeno l'ultimo messaggio, anche
      // quando non ce ne sono di nuovi: lo scartiamo qui.
      if (msg.uid < daUid) continue
      esito.lette += 1
      maxUid = Math.max(maxUid, msg.uid)

      try {
        const email = await analizza(msg.source as Buffer, msg.uid)

        // Tre generi di posta, e solo uno diventa un ticket.
        //  - esclusa: posta di servizio, non entra e basta.
        //  - notifica: avvisi di mancata consegna. Non sono richieste,
        //    ma dicono che una nostra risposta non è arrivata: si
        //    annotano sulla conversazione di quell'ordine.
        //  - messaggio: tutto il resto, compresa la posta diretta di un
        //    cliente che non passa da nessun marketplace.
        const genere = classificaMittente(email, opzioni)

        if (genere === 'escluso') {
          esito.ignorate += 1
          continue
        }

        if (genere === 'notifica') {
          const canale = regole.find((r) => r.kind === 'amazon') ?? casella
          await registraNotifica(
            db,
            log,
            email,
            casella.account_id,
            canale.order_id_pattern,
          )
          esito.notifiche += 1
          continue
        }

        const ric = riconosci(email, regole, casella)
        const agg = await aggancia(db, email, ric)
        const scritto = await upsertEmail(db, log, email, ric, agg, opzioni)

        if (scritto.esito === 'inserito') esito.inserite += 1
        else esito.gia_presenti += 1
      } catch (errore) {
        esito.errori += 1
        // Un errore non si perde mai (regola 5): finisce in
        // ingest_anomaly con abbastanza contesto per riprovare.
        await registraAnomalia(db, casella.account_id, msg.uid, errore)
        log.error({ uid: msg.uid, err: messaggioErrore(errore) }, 'email non elaborata')
      }
    }

    esito.ultimo_uid = maxUid > 0 ? maxUid : null
    await salvaStato(db, casella.account_id, esito.ultimo_uid, uidvalidity, null)
  } catch (errore) {
    await salvaStato(
      db,
      casella.account_id,
      esito.ultimo_uid,
      stato.uidvalidity,
      messaggioErrore(errore),
    )
    throw errore
  } finally {
    // logout() può a sua volta fallire se la connessione è già caduta:
    // non deve mascherare l'errore vero.
    try {
      await client.logout()
    } catch {
      /* la connessione era già chiusa */
    }
  }

  return esito
}

// ---------------------------------------------------------------------
// Stato di sincronizzazione
// ---------------------------------------------------------------------

async function leggiStato(db: Db, accountId: string): Promise<StatoSync> {
  const [riga] = await db<{ imap_uid: string | null; api_cursor: string | null }[]>`
    select imap_uid, api_cursor from sync_state where account_id = ${accountId}
  `
  return {
    imap_uid: riga?.imap_uid != null ? Number(riga.imap_uid) : null,
    // api_cursor è libero: per la casella ci teniamo la UIDVALIDITY.
    uidvalidity: riga?.api_cursor ? Number(riga.api_cursor) : null,
  }
}

async function salvaStato(
  db: Db,
  accountId: string,
  uid: number | null,
  uidvalidity: number | null,
  errore: string | null,
): Promise<void> {
  await db`
    insert into sync_state (
      account_id, imap_uid, api_cursor, last_ok_at, last_error, consecutive_failures
    ) values (
      ${accountId}, ${uid}, ${uidvalidity != null ? String(uidvalidity) : null},
      ${errore ? null : new Date()}, ${errore}, ${errore ? 1 : 0}
    )
    on conflict (account_id) do update set
      imap_uid   = coalesce(excluded.imap_uid, sync_state.imap_uid),
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
  uid: number,
  errore: unknown,
): Promise<void> {
  try {
    await db`
      insert into ingest_anomaly (account_id, tipo, payload)
      values (${accountId}, 'email_non_elaborata', ${db.json({
        uid,
        errore: messaggioErrore(errore),
      })})
    `
  } catch {
    // Se non riusciamo nemmeno a registrare l'anomalia il database è
    // irraggiungibile: il ciclo fallirà comunque poco dopo.
  }
}

export function messaggioErrore(e: unknown): string {
  if (e instanceof Error) return e.message
  return String(e)
}
