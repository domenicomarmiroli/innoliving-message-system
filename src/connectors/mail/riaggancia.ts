import type { Db } from '../../db/index.js'
import type { Logger } from '../../logger.js'
import { caricaRegole } from './regole.js'
import { estraiNumeroOrdine } from './riconosci.js'

/**
 * Riaggancio delle conversazioni rimaste senza ordine.
 *
 * Un messaggio può arrivare PRIMA del suo ordine, e non è un caso
 * eccezionale: gli ordini Amazon oggi non passano dallo Shopify, e anche
 * quando passeranno una email può precedere il webhook di pochi secondi.
 * Un aggancio che avviene una volta sola, al momento dell'ingestione,
 * sbaglierebbe per sempre.
 *
 * Quindi si riprova. Ogni giro di polling ripassa le conversazioni senza
 * ordine e le aggancia se nel frattempo l'ordine è comparso. Il giorno
 * in cui la sincronizzazione Amazon si accende, quelle che aspettano si
 * sistemano da sole entro un minuto: nessuno deve ricordarsi di lanciare
 * niente.
 *
 * Sono poche righe e solo quelle non agganciate, quindi costa poco; e
 * appena una si aggancia esce dall'insieme.
 */

export interface EsitoRiaggancio {
  esaminate: number
  agganciate: number
}

const LIMITE = 1000

export async function riaggancia(
  db: Db,
  log: Logger,
): Promise<EsitoRiaggancio> {
  const { regole } = await caricaRegole(db)
  const patternPerAccount = new Map(
    regole.map((r) => [r.account_id, r.order_id_pattern]),
  )

  const righe = await db<
    {
      id: string
      account_id: string
      state: string
      subject: string | null
      body_text: string | null
    }[]
  >`
    select t.id, t.account_id, t.state,
           m.raw->>'subject'   as subject,
           m.raw->>'body_text' as body_text
    from thread t
    join lateral (
      select raw from message
      where thread_id = t.id and direction = 'in'
      order by sent_at
      limit 1
    ) m on true
    where t.order_id is null
    limit ${LIMITE}
  `

  let agganciate = 0

  for (const r of righe) {
    const numero = estraiNumeroOrdine(
      {
        subject: r.subject,
        body_text: r.body_text,
        // il resto non serve all'estrazione
        rfc822_id: null, in_reply_to: null, references: [], from: null,
        reply_to: null, to: [], date: null, body_html: null,
        allegati: [], uid: null, notifica_tipo: null,
      },
      patternPerAccount.get(r.account_id) ?? null,
    )
    if (!numero) continue

    const [ordine] = await db<{ id: string }[]>`
      select id from "order" where external_order_id = ${numero} limit 1
    `
    if (!ordine) continue

    // La chiave canonica della conversazione è quella dell'ordine, ma
    // solo se nessun'altra la occupa già: due conversazioni sullo stesso
    // ordine vanno unite, e unirle è un problema diverso da questo.
    const [occupata] = await db<{ id: string }[]>`
      select id from thread
      where account_id = ${r.account_id}
        and external_thread_id = ${'ordine:' + ordine.id}
        and id <> ${r.id}
      limit 1
    `

    await db`
      update thread set
        order_id           = ${ordine.id},
        external_thread_id = ${occupata ? db`external_thread_id` : 'ordine:' + ordine.id},
        -- Una conversazione già chiusa resta chiusa: agganciarla a un
        -- ordine è un miglioramento dell'archivio, non lavoro nuovo.
        state              = case when state = 'unmatched' then 'open' else state end,
        updated_at         = now()
      where id = ${r.id}
    `
    agganciate += 1
  }

  agganciate += await agganciaPerEmail(db)

  if (agganciate > 0) {
    log.info(
      { esaminate: righe.length, agganciate },
      'conversazioni agganciate a un ordine comparso dopo',
    )
  }

  return { esaminate: righe.length, agganciate }
}

/**
 * Canali in cui il mittente è l'indirizzo vero del cliente, lo stesso che
 * lascia sull'ordine. Su Amazon e Mirakl scrive un relay: lì non vale.
 */
const KIND_CON_EMAIL_VERA = ['contatto', 'email', 'telefono']

/**
 * Ultima strada: il cliente non cita il numero d'ordine, ma la sua email
 * corrisponde a UN SOLO ordine in archivio. Con più ordini sceglie
 * l'operatore dal pannello (lo stato dell'ordine conta, qui non si indovina).
 *
 * Prudenze: solo ticket degli ultimi 30 giorni, mai le pratiche di garanzia
 * (spesso un acquisto in negozio, non l'unico ordine online del cliente),
 * l'ordine deve esistere già quando il cliente scrive, e una nota interna
 * dice come è stato collegato. La chiave del thread non si tocca: per i
 * form dei siti è la richiesta_id che rende idempotente un nuovo invio.
 *
 * Una query sola, per insiemi, e gli ordini filtrati sulle sole email dei
 * ticket candidati: un confronto per ticket su lower(email) senza indice,
 * o un raggruppamento di tutti gli ordini, va in timeout (~110 ms così).
 */
async function agganciaPerEmail(db: Db): Promise<number> {
  const coppie = await db<{ thread_id: string; order_id: string; nome: string }[]>`
    with c as materialized (
      select t.id as thread_id, m.sent_at,
             lower(substring(coalesce(m.raw->>'reply_to', m.raw->>'from') from '([^<>\s"]+@[^<>\s"]+)')) as email
      from thread t
      join channel_account ca on ca.id = t.account_id
      join lateral (
        select raw, sent_at from message
        where thread_id = t.id and direction = 'in' and author_kind = 'customer' and not interno
        order by sent_at
        limit 1
      ) m on true
      where t.order_id is null
        and t.linked_thread_id is null
        and t.created_at > now() - interval '30 days'
        and ca.kind = any(${KIND_CON_EMAIL_VERA})
        and not ('garanzia' = any(coalesce(t.tags, '{}')))
    ),
    o as (
      select lower(email) as email, count(*) as n,
             (array_agg(id))[1] as order_id,
             min(created_at) as created_at,
             (array_agg(coalesce(shopify_name, external_order_id)))[1] as nome
      from "order"
      where lower(email) in (select email from c)
      group by 1
    )
    select c.thread_id, o.order_id, o.nome
    from c join o on o.email = c.email
    where o.n = 1 and o.created_at <= c.sent_at + interval '1 day'
  `

  let n = 0
  for (const p of coppie) {
    await db.begin(async (tx) => {
      const aggiornate = await tx`
        update thread set
          order_id   = ${p.order_id},
          state      = case when state = 'unmatched' then 'open' else state end,
          updated_at = now()
        where id = ${p.thread_id} and order_id is null
      `
      if (aggiornate.count === 0) return
      await tx`
        insert into message (thread_id, direction, author_kind, body_text, interno, sent_at)
        values (${p.thread_id}, 'out', 'agent',
                ${`Ordine ${p.nome} collegato in automatico: è l'unico ordine in archivio con l'email del cliente. Se non è quello giusto, scollegalo e scegline un altro.`},
                true, now())
      `
      n += 1
    })
  }
  return n
}
