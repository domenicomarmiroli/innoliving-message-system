import type { Config } from '../../config.js'
import type { Db } from '../../db/index.js'
import type { Logger } from '../../logger.js'
import { inviaRisposta } from '../mail/invia.js'
import { linkTracciamento } from '../magazzino/spedizioni.js'
import {
  CANALI_CON_AVVISO,
  STATI_SENZA_AVVISO,
  componiAvviso,
  type StatoPratica,
} from '../../core/pratica/stati.js'

/**
 * Stato della pratica e avvisi al cliente (migrazione 0044).
 *
 * Due tempi, come per le richiamate: chi conosce il nuovo stato lo
 * registra (`registraStatoPratica`, veloce, dentro le rotte e i giri), e un
 * giro separato spedisce gli avvisi (`inviaAvvisiPratica`). Così l'invio
 * di un'email non rallenta la rotta del portale e un server di posta che
 * non risponde non fa perdere lo stato.
 */

const ETICHETTA: Record<StatoPratica, string> = {
  ricevuta: 'pratica ricevuta',
  etichetta_inviata: 'etichetta di reso inviata',
  rientrata: 'prodotto rientrato in magazzino',
  rientrata_sostituzione: 'prodotto rientrato, esito: sostituzione',
  rientrata_sostituzione_altro_modello: 'prodotto rientrato, esito: sostituzione con altro modello',
  rientrata_riparazione: 'prodotto rientrato, esito: riparazione',
  rientrata_funzionante: 'prodotto rientrato, esito: funzionante',
  rientrata_non_conforme: 'prodotto rientrato, esito: non conformità',
  spedita: 'prodotto spedito al cliente',
  chiusa: 'pratica chiusa',
}

export interface NuovoStato {
  thread_id: string
  stato: StatoPratica
  origine: 'portale' | 'magazzino' | 'operatore'
  dettagli?: { tracking?: string | null; corriere?: string | null; [k: string]: unknown }
  agent_id?: string | null
}

/**
 * Registra il nuovo stato. Idempotente su (thread, stato): lo stesso
 * rientro riletto dieci volte non produce dieci avvisi. Restituisce false
 * se lo stato era già stato registrato.
 */
export async function registraStatoPratica(db: Db, s: NuovoStato): Promise<boolean> {
  const [t] = await db<{ kind: string }[]>`
    select ca.kind from thread t join channel_account ca on ca.id = t.account_id where t.id = ${s.thread_id}
  `
  if (!t) return false
  const conAvviso = CANALI_CON_AVVISO.includes(t.kind) && !STATI_SENZA_AVVISO.includes(s.stato)

  const [e] = await db<{ id: number }[]>`
    insert into pratica_evento (thread_id, stato, origine, dettagli, avviso, agent_id)
    values (${s.thread_id}, ${s.stato}, ${s.origine}, ${db.json((s.dettagli ?? {}) as never)},
            ${conAvviso ? 'da_inviare' : 'non_previsto'}, ${s.agent_id ?? null})
    on conflict (thread_id, stato) do nothing
    returning id
  `
  if (!e) return false

  await db`
    update thread set stato_pratica = ${s.stato}, stato_pratica_at = now(), updated_at = now()
    where id = ${s.thread_id}
  `
  if (!conAvviso) {
    await db`
      insert into message (thread_id, direction, author_kind, external_id, body_text, interno, sent_at)
      values (${s.thread_id}, 'out', 'agent', ${`pratica:${e.id}`},
        ${`Stato della pratica: ${ETICHETTA[s.stato]}.${STATI_SENZA_AVVISO.includes(s.stato) ? '' : ' Nessun avviso al cliente: su questo canale lo informa il marketplace.'}`},
        true, now())
      on conflict (thread_id, external_id) do nothing
    `
  }
  return true
}

const PER_GIRO = 20

/** Spedisce gli avvisi in attesa. Un fallimento resta registrato sull'evento e in `ingest_anomaly` (regola 5). */
export async function inviaAvvisiPratica(db: Db, log: Logger, config: Config): Promise<number> {
  const eventi = await db<{ id: number; thread_id: string; stato: StatoPratica; dettagli: Record<string, unknown>; numero: string }[]>`
    select e.id, e.thread_id, e.stato, e.dettagli, t.numero::text as numero
    from pratica_evento e join thread t on t.id = e.thread_id
    where e.avviso = 'da_inviare'
    order by e.created_at
    limit ${PER_GIRO}
  `
  if (eventi.length === 0) return 0

  const [conf] = await db<{ value: Record<string, string> }[]>`select value from app_config where key = 'pratica_avvisi'`
  let inviati = 0

  for (const e of eventi) {
    const modello = conf?.value?.[e.stato]
    try {
      if (!modello) throw new Error(`manca il testo dell'avviso "${e.stato}" in app_config.pratica_avvisi`)
      const tracking = typeof e.dettagli['tracking'] === 'string' ? e.dettagli['tracking'] : null
      const corriere = typeof e.dettagli['corriere'] === 'string' ? e.dettagli['corriere'] : null
      const testo = componiAvviso(modello, {
        numero: e.numero,
        tracking,
        corriere,
        link_tracking: tracking ? linkTracciamento(corriere, tracking) : null,
      })
      const esito = await inviaRisposta(db, log, config, {
        thread_id: e.thread_id,
        agent_id: null,
        testo,
        mantieni_stato: true,
      })
      await db`
        update pratica_evento set avviso = 'inviato', message_id = ${esito.message_id}, inviato_at = now()
        where id = ${e.id}
      `
      inviati++
    } catch (errore) {
      const messaggio = errore instanceof Error ? errore.message : String(errore)
      log.warn({ evento: e.id, err: messaggio }, 'avviso della pratica non inviato')
      // Un solo tentativo: un avviso spedito in ritardo di giorni confonde
      // più di quanto aiuti. L'operatore lo vede nel ticket e scrive lui.
      await db`update pratica_evento set avviso = 'fallito', errore = ${messaggio.slice(0, 500)} where id = ${e.id}`
      await db`
        insert into message (thread_id, direction, author_kind, external_id, body_text, interno, sent_at)
        values (${e.thread_id}, 'out', 'agent', ${`pratica:${e.id}:fallito`},
          ${`Avviso automatico "${ETICHETTA[e.stato]}" NON inviato al cliente: ${messaggio.slice(0, 300)}. Va scritto a mano.`},
          true, now())
        on conflict (thread_id, external_id) do nothing
      `
      await db`
        insert into ingest_anomaly (tipo, payload)
        values ('avviso_pratica_non_inviato', ${db.json({ evento_id: e.id, thread_id: e.thread_id, stato: e.stato, errore: messaggio.slice(0, 500) })})
      `
    }
  }
  if (inviati > 0) log.info({ inviati }, 'avvisi della pratica inviati')
  return inviati
}
