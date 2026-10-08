import type { Db } from '../../db/index.js'
import { cifrePerCifra, dataParlata } from '../../core/voce/stato.js'
import { riduciCap, riduciEmail } from '../../core/voce/verifica.js'
import { normalizzaNumero } from '../../core/voce/richiamata.js'
import {
  CONTATTI_PER_OPERATORE,
  fasePratica,
  giorniLavorativiTra,
  praticaFerma,
  type FasePratica,
} from '../../core/voce/pratica.js'
import { statoDellOrdine } from './ordine.js'

/**
 * Lo stato di una pratica per numero, al telefono. Serve soprattutto a chi
 * ha comprato in negozio e non ha un numero d'ordine: per lui la pratica è
 * l'unico riferimento.
 *
 * Verifica: il numero di pratica da solo non basta (è corto e progressivo).
 * Serve anche UNA fra email, CAP dell'ordine collegato o il numero da cui
 * chiama, se è quello già lasciato nella pratica. Un rifiuto non dice nulla
 * della pratica, nemmeno se esiste.
 *
 * Effetti, solo a verifica riuscita:
 * - nota interna "il cliente ha chiesto lo stato al telefono";
 * - pratica ferma da oltre 10 giorni lavorativi → tag `pratica-ferma`;
 * - terzo contatto o più → tag `contatti-ripetuti`;
 * in entrambi i casi priorità alta e scadenza a 4 ore: decide un operatore.
 */

export const TENTATIVI_PRATICA = 3
const SLA_ALTA_MINUTI = 240

export interface CredenzialiPratica {
  email: string | null
  cap: string | null
  numero_chiamante: string | null
}

export type EsitoPratica =
  | { esito: 'non_verificata'; tentativi_rimasti: number }
  | { esito: 'troppi_tentativi' }
  | {
      esito: 'trovata'
      numero_da_dettare: string
      fase: FasePratica
      aperta_il: string | null
      ultima_nostra_risposta_il: string | null
      pratica_ferma: boolean
      passata_a_operatore: boolean
      spedizione: unknown
    }

export async function statoPratica(
  db: Db,
  conversationId: string,
  numero: number,
  c: CredenzialiPratica,
): Promise<EsitoPratica> {
  const [conteggio] = await db<{ falliti: number }[]>`
    select count(*)::int as falliti from voice_log
    where conversation_id = ${conversationId} and tool = 'stato-pratica' and esito = 'non_verificata'
  `
  const falliti = conteggio?.falliti ?? 0
  if (falliti >= TENTATIVI_PRATICA) return { esito: 'troppi_tentativi' }
  const rifiuto = (): EsitoPratica => ({ esito: 'non_verificata', tentativi_rimasti: Math.max(0, TENTATIVI_PRATICA - falliti - 1) })

  const [t] = await db<{
    id: string; state: string; tags: string[]; order_id: string | null; created_at: Date
    ultima_nostra: Date | null; ultimo_movimento: Date; email_ordine: string | null; cap_ordine: string | null
    tel_ordine: string | null
  }[]>`
    select t.id, t.state, t.tags, t.order_id, t.created_at,
           (select max(m.sent_at) from message m where m.thread_id = t.id and m.direction = 'out' and not m.interno) as ultima_nostra,
           greatest(t.created_at, coalesce((select max(m.sent_at) from message m
             where m.thread_id = t.id and not (m.interno and m.external_id like 'stato-pratica:%')), t.created_at)) as ultimo_movimento,
           o.email as email_ordine, o.shipping_address->>'cap' as cap_ordine, o.shipping_address->>'telefono' as tel_ordine
    from thread t
    join channel_account ca on ca.id = t.account_id
    left join "order" o on o.id = t.order_id
    where t.numero = ${numero} and t.linked_thread_id is null
      and ca.kind in ('contatto', 'email', 'telefono', 'shopify')
  `
  if (!t) return rifiuto()

  const contatti = await db<{ email: string | null; email2: string | null; tel: string | null }[]>`
    select m.raw->>'from' as email, m.raw->>'reply_to' as email2,
           coalesce(m.raw->>'telefono', m.raw->>'numero_chiamante') as tel
    from message m where m.thread_id = ${t.id} and m.author_kind = 'customer'
  `
  const email = c.email ? riduciEmail(c.email) : null
  const cap = c.cap ? riduciCap(c.cap) : null
  const chiamante = normalizzaNumero(c.numero_chiamante)
  const emailNote = [t.email_ordine, ...contatti.flatMap((x) => [x.email, x.email2])].filter((e): e is string => !!e).map(riduciEmail)
  const telNoti = [t.tel_ordine, ...contatti.map((x) => x.tel)].map((n) => normalizzaNumero(n)).filter((n): n is string => !!n)
  const verificata =
    (email !== null && emailNote.includes(email)) ||
    (cap !== null && cap !== '' && t.cap_ordine !== null && riduciCap(t.cap_ordine) === cap) ||
    (chiamante !== null && telNoti.includes(chiamante))
  if (!verificata) return rifiuto()

  const fase = fasePratica(t.state, t.tags)
  const ferma = praticaFerma(fase, t.ultimo_movimento)

  // Questa telefonata conta come contatto: la nota ha una chiave per
  // conversazione, così una seconda domanda nella stessa chiamata non
  // si somma.
  await db`
    insert into message (thread_id, direction, author_kind, external_id, body_text, interno, sent_at)
    values (${t.id}, 'out', 'agent', ${`stato-pratica:${conversationId}`},
      ${`Il cliente ha chiesto al telefono a che punto è la pratica.${ferma ? ` Pratica ferma da ${giorniLavorativiTra(t.ultimo_movimento, new Date())} giorni lavorativi: va sollecitata.` : ''}`},
      true, now())
    on conflict (thread_id, external_id) do nothing
  `
  const [n] = await db<{ contatti: number }[]>`
    select count(*)::int as contatti from message
    where thread_id = ${t.id} and (author_kind = 'customer' or external_id like 'stato-pratica:%')
  `
  const ripetuti = (n?.contatti ?? 0) >= CONTATTI_PER_OPERATORE && fase !== 'chiusa'
  const nuoviTag = [...(ferma ? ['pratica-ferma'] : []), ...(ripetuti ? ['contatti-ripetuti'] : [])]
  if (nuoviTag.length > 0) {
    await db`
      update thread set
        tags = (select array(select distinct unnest(tags || ${[...nuoviTag, 'priorita-alta']}::text[]))),
        state = case when state in ('new', 'closed') then state else 'open' end,
        due_at = least(coalesce(due_at, now() + make_interval(mins => ${SLA_ALTA_MINUTI})), now() + make_interval(mins => ${SLA_ALTA_MINUTI})),
        updated_at = now()
      where id = ${t.id}
    `
  }

  return {
    esito: 'trovata',
    numero_da_dettare: cifrePerCifra(numero),
    fase,
    aperta_il: dataParlata(t.created_at),
    ultima_nostra_risposta_il: dataParlata(t.ultima_nostra),
    pratica_ferma: ferma,
    passata_a_operatore: nuoviTag.length > 0,
    spedizione: t.order_id ? await statoDellOrdine(db, t.order_id) : null,
  }
}
