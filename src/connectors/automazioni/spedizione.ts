import type { Config } from '../../config.js'
import type { Db } from '../../db/index.js'
import type { Logger } from '../../logger.js'
import type { Automazione } from '../../core/automazioni/regole.js'
import {
  compilaAvvisoSpedizione,
  emailContattabile,
  eventoRecente,
  type EventoCorriere,
  type GiacenzaCorriere,
} from '../../core/automazioni/spedizione.js'
import { apriTicketInUscita } from '../mail/nuovo.js'

/**
 * Avviso automatico al cliente quando la spedizione va in giacenza o ha un
 * problema di consegna (automazione `avviso_spedizione`, migrazione 0052).
 *
 * Gira nel ciclo principale. Per ogni ordine nello stato giusto, non già
 * gestito dall'operatore, con un evento del corriere recente e un'email a
 * cui si può scrivere davvero: apre un ticket in uscita dalla casella
 * Microsoft con il testo del modello (link di tracking, eventi, richiesta di
 * un indirizzo o di una data per ritentare). La risposta del cliente si
 * aggancia a quel ticket e lo riapre, come per ogni ticket in uscita.
 *
 * Un solo avviso per ordine e per stato: la riga in `automazione_esecuzione`
 * (chiave `spedizione:<ordine>:<stato>`) si prenota PRIMA di spedire, e un
 * errore non si ritenta da solo — meglio un avviso mancato, visibile in
 * `ingest_anomaly`, che il dubbio di averne mandati due.
 */

const PER_GIRO = 10

interface Candidato {
  id: string
  channel: string
  external_order_id: string
  shopify_name: string | null
  email: string | null
  nome: string | null
  spedizione_stato: string
  tracking_number: string
  tracking_url: string | null
  tracking_eventi: unknown
  tracking_giacenza: unknown
}

export interface EsitoAvvisiSpedizione {
  inviati: number
  errori: number
  non_contattabili: number
}

function eventi(v: unknown): EventoCorriere[] {
  if (!Array.isArray(v)) return []
  return v.filter(
    (e): e is EventoCorriere =>
      !!e && typeof e === 'object' && typeof (e as EventoCorriere).data === 'string' && typeof (e as EventoCorriere).evento === 'string',
  )
}

function giacenza(v: unknown): GiacenzaCorriere | null {
  return v && typeof v === 'object' && !Array.isArray(v) ? (v as GiacenzaCorriere) : null
}

export async function inviaAvvisiSpedizione(
  db: Db,
  log: Logger,
  config: Config,
  automazioni: Automazione[],
  ora: Date = new Date(),
): Promise<EsitoAvvisiSpedizione> {
  const esito: EsitoAvvisiSpedizione = { inviati: 0, errori: 0, non_contattabili: 0 }

  for (const regola of automazioni.filter((a) => a.attiva && a.azione === 'avviso_spedizione')) {
    const stati = regola.condizione.stati_spedizione
    const candidati = await db<Candidato[]>`
      select o.id, o.channel, o.external_order_id, o.shopify_name, o.email,
             coalesce(o.shipping_address->>'nome', o.billing_address->>'nome') as nome,
             o.spedizione_stato, o.tracking_number, o.tracking_url, o.tracking_eventi, o.tracking_giacenza
      from "order" o
      where o.spedizione_stato = any(${stati})
        and o.spedizione_gestita_at is null
        and o.tracking_number is not null
        and o.spedizione_aggiornata_at > now() - make_interval(hours => ${regola.parametri.max_eta_ore})
        and not exists (
          select 1 from automazione_esecuzione e
          where e.automazione_id = ${regola.id}
            and e.chiave = 'spedizione:' || o.id || ':' || o.spedizione_stato
        )
      order by o.spedizione_aggiornata_at
      limit 200
    `

    let inviatiRegola = 0
    for (const o of candidati) {
      if (inviatiRegola >= PER_GIRO) break
      const evs = eventi(o.tracking_eventi)
      if (!eventoRecente(evs, ora, regola.parametri.max_eta_ore)) continue
      if (!emailContattabile(o.email, regola.condizione.domini_esclusi)) {
        esito.non_contattabili += 1
        continue
      }

      const chiave = `spedizione:${o.id}:${o.spedizione_stato}`
      const [prenotata] = await db<{ id: string }[]>`
        insert into automazione_esecuzione (automazione_id, chiave, esito)
        values (${regola.id}, ${chiave}, 'in_corso')
        on conflict (automazione_id, chiave) do nothing
        returning id
      `
      if (!prenotata) continue
      inviatiRegola += 1

      try {
        const nomeModello = regola.parametri.modelli[o.spedizione_stato]
        const [modello] = await db<{ subject_tpl: string | null; body_tpl: string | null }[]>`
          select subject_tpl, body_tpl from template where name = ${nomeModello ?? ''}
        `
        if (!modello?.body_tpl) throw new Error(`modello «${nomeModello}» non trovato nella tabella template`)
        const dati = {
          nome_cliente: o.nome,
          numero_ordine: o.external_order_id || o.shopify_name || '',
          tracking_numero: o.tracking_number,
          tracking_link: o.tracking_url,
          eventi: evs,
          giacenza: giacenza(o.tracking_giacenza),
        }
        const corpo = compilaAvvisoSpedizione(modello.body_tpl, dati)
        if (!corpo.ok) throw new Error(corpo.motivo)
        const oggetto = compilaAvvisoSpedizione(modello.subject_tpl || 'Aggiornamento sulla consegna del suo ordine {{ordine.numero}}', dati)
        if (!oggetto.ok) throw new Error(oggetto.motivo)

        const aperto = await apriTicketInUscita(db, log, config, {
          agent_id: null,
          destinatario: o.email!,
          oggetto: oggetto.testo,
          testo: corpo.testo,
          order_id: o.id,
          tags: ['avviso-spedizione', `spedizione-${o.spedizione_stato}`, ...regola.parametri.tag],
        })

        await db.begin(async (tx) => {
          await tx`
            insert into message (thread_id, direction, author_kind, body_text, interno, sent_at)
            values (${aperto.thread_id}, 'out', 'agent',
                    ${`Avviso automatico al cliente (regola ${regola.codice}): spedizione ${o.tracking_number} in stato "${o.spedizione_stato}". Ticket chiuso: se il cliente risponde si riapre da solo.`},
                    true, now())
          `
          // Chiuso subito (scelta di Domenico, 12/11): è un avviso, non una
          // domanda in sospeso. Se il cliente risponde, la sua email si
          // aggancia a questo ticket e lo riapre (upsert.ts riapre 'closed').
          await tx`
            update thread set state = 'closed', updated_at = now()
            where id = ${aperto.thread_id}
          `
          await tx`
            update automazione_esecuzione set
              esito = 'inviato', thread_id = ${aperto.thread_id}, risposta_id = ${aperto.message_id}, updated_at = now()
            where id = ${prenotata.id}
          `
        })
        esito.inviati += 1
        log.info({ automazione: regola.codice, order_id: o.id, thread_id: aperto.thread_id }, 'avviso spedizione inviato')
      } catch (errore) {
        const messaggio = (errore instanceof Error ? errore.message : String(errore)).slice(0, 500)
        esito.errori += 1
        log.error({ automazione: regola.codice, order_id: o.id, err: messaggio }, 'avviso spedizione non inviato')
        try {
          await db`
            update automazione_esecuzione set esito = 'errore', errore = ${messaggio}, updated_at = now()
            where id = ${prenotata.id}
          `
          await db`
            insert into ingest_anomaly (tipo, payload)
            values ('automazione_avviso_spedizione_fallito',
                    ${db.json({ automazione: regola.codice, order_id: o.id, stato: o.spedizione_stato, errore: messaggio })})
          `
        } catch {
          /* il log qui sopra resta */
        }
      }
    }
  }

  return esito
}
