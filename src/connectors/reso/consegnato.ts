import type { Db } from '../../db/index.js'
import type { Logger } from '../../logger.js'
import { registraStatoPratica } from '../pratica/avvisi.js'
import { minutiSla } from '../voce/ticket.js'
import { STATI_PRATICA, type StatoPratica } from '../../core/pratica/stati.js'

/**
 * Reso consegnato al magazzino → il ticket si riapre (migrazione 0057).
 *
 * Chiesto da Domenico il 2026-11-26 (ticket 15861): il tracking BRT diceva
 * CONSEGNATA ma il ticket restava chiuso. Quando il reso arriva c'è sempre
 * un'azione: rispedire il prodotto, rimborsare, scrivere al cliente.
 *  - ticket di nuovo aperto, con la scadenza da adesso e il tag `reso-consegnato`;
 *  - nota interna con data e ora della consegna;
 *  - per le garanzie, pratica "rientrata" (avviso al cliente dove scriviamo
 *    noi; su Amazon e Mirakl resta una nota), a meno che il magazzino non
 *    abbia già registrato un esito più avanti.
 * Una volta sola per etichetta (`riapertura_at`).
 */

export const TAG_RESO_CONSEGNATO = 'reso-consegnato'

const TIPO_LEGGIBILE: Record<string, string> = {
  recesso: 'recesso',
  danneggiato: 'prodotto danneggiato',
  verificare: 'da verificare',
  garanzia: 'garanzia',
}

/** Gli stati da cui "rientrata" sarebbe un passo indietro. */
const OLTRE_IL_RIENTRO: readonly StatoPratica[] = STATI_PRATICA.filter(
  (s) => s.startsWith('rientrata') || s === 'spedita' || s === 'chiusa',
)

export function quandoLeggibile(d: Date): string {
  const giorno = d.toLocaleDateString('it-IT', { timeZone: 'Europe/Rome', day: '2-digit', month: '2-digit' })
  const ora = d.toLocaleTimeString('it-IT', { timeZone: 'Europe/Rome', hour: '2-digit', minute: '2-digit' })
  return `${giorno} alle ${ora}`
}

export function notaResoConsegnato(tipo: string, consegnato: Date | null): string {
  const quando = consegnato ? ` il ${quandoLeggibile(consegnato)}` : ''
  return (
    `Reso (${TIPO_LEGGIBILE[tipo] ?? tipo}) consegnato da BRT al magazzino${quando}. ` +
    'Ticket riaperto: ora si può rispedire il prodotto, rimborsare o scrivere al cliente.'
  )
}

interface DaRiaprire {
  id: string
  thread_id: string
  tipo: string
  spedizione_consegnata_at: Date | null
  stato_pratica: StatoPratica | null
  sla_minutes: number
  tags: string[] | null
}

export async function riapriResiConsegnati(db: Db, log: Logger, massimo = 50): Promise<number> {
  const righe = await db<DaRiaprire[]>`
    select e.id, e.thread_id, e.tipo, e.spedizione_consegnata_at, t.stato_pratica, ca.sla_minutes, t.tags
    from etichetta_reso e
    join thread t on t.id = e.thread_id
    join channel_account ca on ca.id = t.account_id
    where e.spedizione_stato = 'consegnato' and e.riapertura_at is null and e.thread_id is not null
    order by e.spedizione_consegnata_at nulls last
    limit ${massimo}
  `
  let riaperti = 0
  for (const r of righe) {
    try {
      // Prima si prende l'etichetta: un secondo giro in parallelo non la rifà.
      const [presa] = await db<{ id: string }[]>`
        update etichetta_reso set riapertura_at = now() where id = ${r.id} and riapertura_at is null returning id
      `
      if (!presa) continue
      const scadenza = new Date(Date.now() + minutiSla(r.sla_minutes, r.tags) * 60_000)
      await db`
        update thread set
          state = 'open', closed_at = null, due_at = ${scadenza},
          tags = (select array(select distinct unnest(tags || ${[TAG_RESO_CONSEGNATO]}::text[]))),
          updated_at = now()
        where id = ${r.thread_id}
      `
      await db`
        insert into message (thread_id, direction, author_kind, external_id, body_text, interno, sent_at)
        values (${r.thread_id}, 'out', 'agent', ${`reso-consegnato:${r.id}`},
                ${notaResoConsegnato(r.tipo, r.spedizione_consegnata_at)}, true, now())
        on conflict (thread_id, external_id) do nothing
      `
      if (r.tipo === 'garanzia' && !(r.stato_pratica && OLTRE_IL_RIENTRO.includes(r.stato_pratica))) {
        await registraStatoPratica(db, {
          thread_id: r.thread_id,
          stato: 'rientrata',
          origine: 'magazzino',
          dettagli: { fonte: 'tracking_brt', consegnato_il: r.spedizione_consegnata_at },
        })
      }
      riaperti++
    } catch (errore) {
      log.error({ etichetta_id: r.id, err: errore instanceof Error ? errore.message : String(errore) }, 'riapertura per reso consegnato fallita')
      await db`insert into ingest_anomaly (tipo, payload) values ('reso_consegnato_riapertura', ${db.json({ etichetta_id: r.id, thread_id: r.thread_id, errore: errore instanceof Error ? errore.message : String(errore) } as never)})`.catch(() => {})
    }
  }
  if (riaperti > 0) log.info({ riaperti }, 'ticket riaperti per reso consegnato al magazzino')
  return riaperti
}
