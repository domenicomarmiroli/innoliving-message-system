import { createHash } from 'node:crypto'

import type { Config } from '../../config.js'
import type { Db } from '../../db/index.js'
import type { CategoriaIntento } from '../../core/ai/intento.js'

/**
 * Ticket aperti dall'agente vocale (canale 'telefono', migrazione 0032).
 *
 * Uno per telefonata: la chiave è il `conversation_id` di ElevenLabs in
 * `thread.external_thread_id`. Se l'agente chiama lo strumento due volte
 * nella stessa conversazione (capita: il modello ritenta, o il cliente
 * aggiunge un secondo problema) non nasce un secondo ticket, si aggiunge
 * un messaggio a quello esistente — e la stessa descrizione due volte non
 * diventa due messaggi.
 *
 * Se il cliente lascia un'email, finisce in `raw.from`: è il campo da cui
 * `mail/invia.ts` prende il destinatario, quindi l'operatore risponde dal
 * ticket come a qualunque email, senza codice in più. Con il solo
 * telefono la risposta è una richiamata.
 */

export type CategoriaVoce = 'spedizione' | 'difetto_prodotto' | 'reso' | 'garanzia' | 'info' | 'altro'

/** Le categorie dette dall'agente, tradotte nella tassonomia dei tag già usata da knowledge base e report. */
const TAG_CATEGORIA: Record<CategoriaVoce, CategoriaIntento> = {
  spedizione: 'spedizione-tracking',
  difetto_prodotto: 'prodotto-difettoso',
  reso: 'reso',
  garanzia: 'garanzia',
  info: 'domanda-prodotto',
  altro: 'altro',
}

const ETICHETTA_CATEGORIA: Record<CategoriaVoce, string> = {
  spedizione: 'spedizione',
  difetto_prodotto: 'prodotto difettoso',
  reso: 'reso',
  garanzia: 'garanzia',
  info: 'informazioni',
  altro: 'altro',
}

/** SLA di un ticket ad alta priorità: lo stesso bucket "urgente" degli avvisi A-to-Z. */
const SLA_ALTA_MINUTI = 240

export interface RichiestaTicketVoce {
  conversation_id: string
  order_id: string | null
  riferimento_ordine: string | null
  categoria: CategoriaVoce
  priorita: 'normale' | 'alta'
  descrizione: string
  prodotto: string | null
  nome: string | null
  contatto_richiamata: string
  numero_chiamante: string | null
}

export function contattoEmail(contatto: string): string | null {
  const t = contatto.trim()
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(t) ? t.toLowerCase() : null
}

export function tagTicketVoce(categoria: CategoriaVoce, priorita: 'normale' | 'alta'): string[] {
  return ['telefono', TAG_CATEGORIA[categoria], ...(priorita === 'alta' ? ['priorita-alta'] : [])]
}

export function oggettoTicketVoce(categoria: CategoriaVoce, riferimentoOrdine: string | null): string {
  const base = `Telefono — ${ETICHETTA_CATEGORIA[categoria]}`
  return riferimentoOrdine ? `${base} — ordine ${riferimentoOrdine}` : base
}

/** Il testo del messaggio: le parole del cliente prima, i dati raccolti dopo, leggibili da un operatore. */
export function testoTicketVoce(r: RichiestaTicketVoce): string {
  const righe = [r.descrizione.trim(), '']
  if (r.prodotto) righe.push(`Prodotto: ${r.prodotto}`)
  if (r.nome) righe.push(`Nome: ${r.nome}`)
  righe.push(`Contatto per la risposta: ${r.contatto_richiamata}`)
  if (r.numero_chiamante && r.numero_chiamante !== r.contatto_richiamata) {
    righe.push(`Numero da cui ha chiamato: ${r.numero_chiamante}`)
  }
  righe.push(r.order_id ? 'Cliente verificato sull\'ordine.' : 'Cliente NON verificato su un ordine.')
  return righe.join('\n')
}

export async function apriTicketVoce(
  db: Db,
  config: Config,
  r: RichiestaTicketVoce,
): Promise<{ numero: number; thread_id: string; nuovo: boolean; esistente: boolean }> {
  // Ordine verificato con una conversazione già in corso (caso reale 06/10:
  // il cliente chiama per un ordine che ha già un ticket Amazon): la
  // telefonata va lì, non in un ticket parallelo che l'operatore
  // scoprirebbe per caso.
  if (r.order_id) {
    const esistente = await aggiungiAlTicketDellOrdine(db, r)
    if (esistente) return esistente
  }

  const [account] = await db<{ id: string; sla_minutes: number }[]>`
    select id, sla_minutes from channel_account
    where kind = 'telefono' and active
    order by created_at
    limit 1
  `
  if (!account) {
    throw new Error("Manca l'account con kind 'telefono': eseguire la migrazione 0032.")
  }

  const ora = new Date()
  const minuti = r.priorita === 'alta' ? Math.min(SLA_ALTA_MINUTI, account.sla_minutes) : account.sla_minutes
  const scadenza = new Date(ora.getTime() + minuti * 60_000)
  const oggetto = oggettoTicketVoce(r.categoria, r.riferimento_ordine)
  const testo = testoTicketVoce(r)
  const email = contattoEmail(r.contatto_richiamata)
  // La risposta per email parte dalla casella aziendale se c'è, altrimenti
  // da quella storica: è la casella che ha senso per un cliente nuovo.
  const casella = config.MS_MAILBOX ? 'graph' : 'imap'
  const chiaveMessaggio = `${r.conversation_id}:${createHash('sha256').update(testo).digest('hex').slice(0, 16)}`

  return db.begin(async (tx) => {
    const [thread] = await tx<{ id: string; numero: string; nuovo: boolean }[]>`
      insert into thread (
        account_id, external_thread_id, order_id, subject, state,
        tags, first_inbound_at, last_inbound_at, due_at
      ) values (
        ${account.id}, ${r.conversation_id}, ${r.order_id}, ${oggetto}, 'new',
        ${tagTicketVoce(r.categoria, r.priorita)}, ${ora}, ${ora}, ${scadenza}
      )
      on conflict (account_id, external_thread_id) where external_thread_id is not null
      do update set
        last_inbound_at = excluded.last_inbound_at,
        tags = (select array(select distinct unnest(thread.tags || excluded.tags))),
        state = case when thread.state = 'closed' then 'open' else thread.state end,
        updated_at = now()
      returning id, numero::text as numero, (xmax = 0) as nuovo
    `

    await tx`
      insert into message (thread_id, direction, author_kind, external_id, body_text, sent_at, raw)
      values (
        ${thread!.id}, 'in', 'customer', ${chiaveMessaggio}, ${testo}, ${ora},
        ${tx.json({
          canale: 'telefono',
          conversation_id: r.conversation_id,
          from: email,
          telefono: email ? null : r.contatto_richiamata,
          numero_chiamante: r.numero_chiamante,
          nome: r.nome,
          categoria: r.categoria,
          priorita: r.priorita,
          prodotto: r.prodotto,
          subject: oggetto,
          casella,
        } as never)}
      )
      on conflict (thread_id, external_id) do nothing
    `

    return { numero: Number(thread!.numero), thread_id: thread!.id, nuovo: thread!.nuovo, esistente: false }
  })
}

/** Un ticket chiuso da più di così non si riapre per una nuova telefonata: è un'altra storia. */
const GIORNI_RIAPERTURA = 30

export function notaTelefonata(testo: string): string {
  return `Il cliente ha chiamato l'assistente vocale.

${testo}`
}

/**
 * La telefonata entra come NOTA INTERNA nel ticket esistente, non come
 * messaggio del cliente: `inviaRisposta()` risponde all'ultimo messaggio
 * del cliente, e un messaggio con l'email lasciata al telefono farebbe
 * partire la risposta lì invece che verso l'alias del marketplace (stesso
 * difetto del bug del 10/09). Il contatto resta scritto nella nota.
 */
async function aggiungiAlTicketDellOrdine(
  db: Db,
  r: RichiestaTicketVoce,
): Promise<{ numero: number; thread_id: string; nuovo: boolean; esistente: boolean } | null> {
  const testo = notaTelefonata(testoTicketVoce(r))
  const chiave = `${r.conversation_id}:${createHash('sha256').update(testo).digest('hex').slice(0, 16)}`
  const scadenza = new Date(Date.now() + (r.priorita === 'alta' ? SLA_ALTA_MINUTI : 24 * 60) * 60_000)

  return db.begin(async (tx) => {
    const [t] = await tx<{ id: string; numero: string }[]>`
      select t.id, t.numero::text as numero
      from thread t
      where t.order_id = ${r.order_id}
        and t.linked_thread_id is null
        and (t.state <> 'closed' or t.closed_at > now() - make_interval(days => ${GIORNI_RIAPERTURA}))
      order by (t.state <> 'closed') desc, t.last_inbound_at desc nulls last, t.created_at desc
      limit 1
    `
    if (!t) return null
    await tx`
      insert into message (thread_id, direction, author_kind, external_id, body_text, interno, sent_at)
      values (${t.id}, 'out', 'agent', ${chiave}, ${testo}, true, now())
      on conflict (thread_id, external_id) do nothing
    `
    await tx`
      update thread set
        state      = case when state = 'new' then state else 'open' end,
        tags       = (select array(select distinct unnest(tags || ${tagTicketVoce(r.categoria, r.priorita)}::text[]))),
        due_at     = least(coalesce(due_at, ${scadenza}), ${scadenza}),
        updated_at = now()
      where id = ${t.id}
    `
    return { numero: Number(t.numero), thread_id: t.id, nuovo: false, esistente: true }
  })
}
