import type { Config } from '../../config.js'
import type { Db } from '../../db/index.js'
import type { Logger } from '../../logger.js'
import { cifrePerCifra } from '../../core/voce/stato.js'
import { nomeCorrisponde, nomeDiBattesimo } from '../../core/voce/verifica.js'
import {
  REGOLE_PREDEFINITE,
  dentroFascia,
  normalizzaNumero,
  primoTentativo,
  prossimoTentativo,
  type EsitoTentativo,
  type RegoleRichiamata,
} from '../../core/voce/richiamata.js'

/**
 * Richiamata del cliente con l'agente vocale (migrazione 0042).
 *
 * L'operatore scrive cosa dire o chiedere; il giro periodico fa partire la
 * telefonata (API ElevenLabs "outbound call via SIP trunk") quando è il
 * momento, e il webhook di fine chiamata registra l'esito. Se il cliente
 * non risponde (squilla a vuoto, occupato, segreteria) si riprova fra una
 * e due ore, solo nella fascia 8-21 dello stesso giorno; poi la richiamata
 * torna all'operatore come "non raggiunto".
 *
 * Ogni passaggio lascia una nota interna nel ticket: l'operatore vede
 * tentativi ed esito senza cercarli altrove.
 */

const API = 'https://api.elevenlabs.io/v1/convai/sip-trunk/outbound-call'

export function richiamataConfigurata(config: Config): boolean {
  return !!(config.ELEVENLABS_API_KEY && config.ELEVENLABS_RICHIAMATA_AGENT_ID && config.ELEVENLABS_PHONE_NUMBER_ID)
}

export async function regoleRichiamata(db: Db): Promise<RegoleRichiamata> {
  const [riga] = await db<{ value: Partial<RegoleRichiamata> }[]>`
    select value from app_config where key = 'voce_richiamate'
  `
  return { ...REGOLE_PREDEFINITE, ...(riga?.value ?? {}) }
}

/**
 * I numeri che l'operatore può scegliere senza riscriverli: quello lasciato
 * al telefono, quello da cui ha chiamato, quelli degli indirizzi
 * dell'ordine. Già normalizzati, senza doppioni.
 */
export async function numeriSuggeriti(db: Db, threadId: string): Promise<Array<{ numero: string; fonte: string }>> {
  const righe = await db<{ valore: string | null; fonte: string }[]>`
    select m.raw->>'telefono' as valore, 'lasciato dal cliente' as fonte
    from message m where m.thread_id = ${threadId} and m.direction = 'in'
    union all
    select m.raw->>'numero_chiamante', 'numero da cui ha chiamato'
    from message m where m.thread_id = ${threadId} and m.direction = 'in'
    union all
    select o.shipping_address->>'telefono', 'indirizzo di spedizione'
    from thread t join "order" o on o.id = t.order_id where t.id = ${threadId}
    union all
    select o.billing_address->>'telefono', 'indirizzo di fatturazione'
    from thread t join "order" o on o.id = t.order_id where t.id = ${threadId}
  `
  const visti = new Set<string>()
  const esito: Array<{ numero: string; fonte: string }> = []
  for (const r of righe) {
    const n = normalizzaNumero(r.valore)
    if (n && !visti.has(n)) {
      visti.add(n)
      esito.push({ numero: n, fonte: r.fonte })
    }
  }
  return esito
}

async function nota(db: Db, threadId: string, chiave: string, testo: string): Promise<void> {
  await db`
    insert into message (thread_id, direction, author_kind, external_id, body_text, interno, sent_at)
    values (${threadId}, 'out', 'agent', ${chiave}, ${testo}, true, now())
    on conflict (thread_id, external_id) do nothing
  `
}

const oraParlata = (d: Date) =>
  new Intl.DateTimeFormat('it-IT', { timeZone: 'Europe/Rome', hour: '2-digit', minute: '2-digit' }).format(d)
const giornoEOra = (d: Date) =>
  new Intl.DateTimeFormat('it-IT', { timeZone: 'Europe/Rome', weekday: 'long', day: 'numeric', month: 'long', hour: '2-digit', minute: '2-digit' }).format(d)

export class RichiamataNonValida extends Error {}

export async function creaRichiamata(
  db: Db,
  r: { thread_id: string; numero: string; messaggio: string; agent_id: string | null },
): Promise<{ id: string; numero: string; primo_tentativo_at: Date }> {
  const numero = normalizzaNumero(r.numero)
  if (!numero) throw new RichiamataNonValida('Numero di telefono non valido: scrivilo con il prefisso, per esempio +39 347 1234567.')
  const [aperta] = await db<{ id: string }[]>`
    select id from richiamata where thread_id = ${r.thread_id} and stato in ('in_attesa', 'in_corso')
  `
  if (aperta) throw new RichiamataNonValida("C'è già una richiamata in corso per questo ticket: annullala prima di farne un'altra.")

  const regole = await regoleRichiamata(db)
  const quando = primoTentativo(new Date(), regole)
  const [riga] = await db<{ id: string }[]>`
    insert into richiamata (thread_id, numero, messaggio, prossimo_tentativo_at, creata_da)
    values (${r.thread_id}, ${numero}, ${r.messaggio.trim()}, ${quando}, ${r.agent_id})
    returning id
  `
  const subito = quando.getTime() - Date.now() < 60_000
  await nota(
    db,
    r.thread_id,
    `richiamata:${riga!.id}:creata`,
    `Richiamata con l'assistente vocale al ${numero}${subito ? ': parte entro un minuto.' : `: fuori dalla fascia oraria, parte ${giornoEOra(quando)}.`}\nMessaggio da riferire: ${r.messaggio.trim()}`,
  )
  return { id: riga!.id, numero, primo_tentativo_at: quando }
}

export async function annullaRichiamata(db: Db, id: string, threadId: string): Promise<boolean> {
  const righe = await db`
    update richiamata set stato = 'annullata', conclusa_at = now(), prossimo_tentativo_at = null, updated_at = now()
    where id = ${id} and thread_id = ${threadId} and stato in ('in_attesa', 'in_corso')
  `
  if (righe.count > 0) await nota(db, threadId, `richiamata:${id}:annullata`, 'Richiamata annullata dall\'operatore.')
  return righe.count > 0
}

/** La telefonata vera e propria. Restituisce il conversation_id di ElevenLabs. */
export async function avviaChiamata(
  config: Config,
  numero: string,
  variabili: Record<string, string>,
): Promise<string> {
  const risposta = await fetch(API, {
    method: 'POST',
    headers: { 'xi-api-key': config.ELEVENLABS_API_KEY!, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      agent_id: config.ELEVENLABS_RICHIAMATA_AGENT_ID,
      agent_phone_number_id: config.ELEVENLABS_PHONE_NUMBER_ID,
      to_number: numero,
      conversation_initiation_client_data: { dynamic_variables: variabili },
    }),
  })
  const corpo = (await risposta.json().catch(() => ({}))) as { success?: boolean; conversation_id?: string | null; message?: string; detail?: unknown }
  if (!risposta.ok || corpo.success === false || !corpo.conversation_id) {
    throw new Error(`ElevenLabs non ha avviato la chiamata (${risposta.status}): ${corpo.message ?? JSON.stringify(corpo.detail ?? corpo).slice(0, 200)}`)
  }
  return corpo.conversation_id
}

/** Il giro: fa partire le richiamate arrivate al loro momento. */
export async function eseguiRichiamate(db: Db, log: Logger, config: Config): Promise<number> {
  const regole = await regoleRichiamata(db)
  const ora = new Date()
  if (!dentroFascia(ora, regole)) return 0

  // Una chiamata rimasta "in corso" senza webhook da oltre 30 minuti: il
  // webhook si è perso. Si tratta come mancata risposta, per non lasciare
  // la richiamata ferma per sempre.
  const ferme = await db<{ conversation_id: string }[]>`
    select rt.conversation_id from richiamata_tentativo rt
    join richiamata r on r.id = rt.richiamata_id
    where r.stato = 'in_corso' and rt.esito is null and rt.avviato_at < now() - interval '30 minutes'
      and rt.conversation_id is not null
  `
  for (const f of ferme) await registraEsito(db, log, f.conversation_id, 'non_raggiunto', null)

  const daFare = await db<{ id: string; thread_id: string; numero: string; messaggio: string; tentativi: number }[]>`
    update richiamata set stato = 'in_corso', updated_at = now()
    where id in (
      select id from richiamata
      where stato = 'in_attesa' and prossimo_tentativo_at <= now()
      order by prossimo_tentativo_at
      limit 3
      for update skip locked
    )
    returning id, thread_id, numero, messaggio, tentativi
  `
  for (const r of daFare) {
    try {
      const [t] = await db<{ numero: string; nome: string | null }[]>`
        select t.numero::text as numero,
               coalesce(
                 (select m.raw->>'nome' from message m where m.thread_id = t.id and m.direction = 'in' and m.raw->>'nome' is not null order by m.sent_at limit 1),
                 (select o.shipping_address->>'nome' from "order" o where o.id = t.order_id)
               ) as nome
        from thread t where t.id = ${r.thread_id}
      `
      const nome = nomeDiBattesimo(t?.nome)
      const conversationId = await avviaChiamata(config, r.numero, {
        nome_cliente: nome ?? '',
        // Per il primo messaggio "Parlo con …?": mai una frase monca se il
        // nome manca.
        saluto_cliente: nome ?? 'la persona che ha contattato la nostra assistenza',
        messaggio_operatore: r.messaggio,
        numero_pratica: cifrePerCifra(t?.numero ?? ''),
      })
      await db`insert into richiamata_tentativo (richiamata_id, conversation_id) values (${r.id}, ${conversationId})`
      await db`update richiamata set tentativi = tentativi + 1, updated_at = now() where id = ${r.id}`
      log.info({ richiamata: r.id, tentativo: r.tentativi + 1 }, 'richiamata avviata')
    } catch (errore) {
      // La chiamata non è nemmeno partita: conta come tentativo, così un
      // errore di configurazione non fa chiamare all'infinito.
      const messaggio = errore instanceof Error ? errore.message : String(errore)
      log.error({ richiamata: r.id, err: messaggio }, 'richiamata non avviata')
      // Regola 5: il motivo deve essere leggibile senza la shell di Render.
      // Il numero non va nel payload: basta l'id della richiamata.
      await db`
        insert into ingest_anomaly (tipo, payload)
        values ('richiamata_non_avviata', ${db.json({ richiamata_id: r.id, thread_id: r.thread_id, tentativo: r.tentativi + 1, errore: messaggio.slice(0, 500) })})
      `
      await db`update richiamata set tentativi = tentativi + 1, updated_at = now() where id = ${r.id}`
      await pianificaDopo(db, r.id, r.thread_id, r.tentativi + 1, 'errore', regole, messaggio)
    }
  }
  return daFare.length
}

async function pianificaDopo(
  db: Db,
  id: string,
  threadId: string,
  tentativiFatti: number,
  esito: EsitoTentativo,
  regole: RegoleRichiamata,
  dettaglio?: string,
): Promise<void> {
  const perche = dettaglio ? ` (${dettaglio.slice(0, 300)})` : ''
  const motivo: Record<EsitoTentativo, string> = {
    'no-answer': 'non ha risposto',
    busy: 'occupato',
    segreteria: 'segreteria',
    non_raggiunto: 'non raggiunto',
    errore: 'chiamata non partita',
    risposto: 'risposto',
  }
  const prossimo = prossimoTentativo(new Date(), tentativiFatti, regole)
  if (prossimo) {
    await db`
      update richiamata set stato = 'in_attesa', prossimo_tentativo_at = ${prossimo}, ultimo_esito = ${esito}, updated_at = now()
      where id = ${id}
    `
    await nota(db, threadId, `richiamata:${id}:${tentativiFatti}`,
      `Richiamata, tentativo ${tentativiFatti}: ${motivo[esito]}${perche}. Riprovo alle ${oraParlata(prossimo)}.`)
  } else {
    await db`
      update richiamata set stato = 'non_raggiunto', prossimo_tentativo_at = null, ultimo_esito = ${esito},
        conclusa_at = now(), updated_at = now()
      where id = ${id}
    `
    await nota(db, threadId, `richiamata:${id}:${tentativiFatti}`,
      `Richiamata, tentativo ${tentativiFatti}: ${motivo[esito]}${perche}. Cliente non raggiunto oggi: la richiamata si ferma qui, serve un'altra strada (email) o una nuova richiamata.`)
    // Torna all'operatore: il ticket riappare in coda.
    await db`update thread set state = 'open', updated_at = now() where id = ${threadId} and state <> 'open'`
  }
}

/**
 * L'esito di una telefonata, dal webhook di fine chiamata o da una
 * chiamata non partita. Restituisce l'id del ticket se la conversazione era
 * una richiamata, null altrimenti (allora il webhook la tratta come una
 * telefonata in arrivo, come prima).
 */
export async function registraEsito(
  db: Db,
  log: Logger,
  conversationId: string,
  esito: EsitoTentativo,
  riassunto: string | null,
): Promise<string | null> {
  const [t] = await db<{ id: string; richiamata_id: string; thread_id: string; tentativi: number; stato: string }[]>`
    update richiamata_tentativo rt set esito = coalesce(rt.esito, ${esito}), concluso_at = coalesce(rt.concluso_at, now())
    from richiamata r
    where rt.conversation_id = ${conversationId} and r.id = rt.richiamata_id
    returning rt.id, r.id as richiamata_id, r.thread_id, r.tentativi, r.stato
  `
  if (!t) return null
  // Webhook ripetuto, o richiamata annullata nel frattempo: niente da fare.
  if (t.stato !== 'in_corso') return t.thread_id

  if (esito === 'risposto') {
    await db`
      update richiamata set stato = 'completata', ultimo_esito = 'risposto', prossimo_tentativo_at = null,
        conclusa_at = now(), updated_at = now()
      where id = ${t.richiamata_id}
    `
    await nota(db, t.thread_id, `richiamata:${t.richiamata_id}:completata`,
      `Richiamata riuscita al tentativo ${t.tentativi}.${riassunto ? `\nRiassunto: ${riassunto}` : ''}\nLa trascrizione è disponibile.`)
    // Le risposte del cliente vanno lette: il ticket torna in coda.
    await db`update thread set state = 'open', last_inbound_at = now(), updated_at = now() where id = ${t.thread_id}`
  } else {
    await pianificaDopo(db, t.richiamata_id, t.thread_id, t.tentativi, esito, await regoleRichiamata(db))
  }
  log.info({ richiamata: t.richiamata_id, esito }, 'esito della richiamata registrato')
  return t.thread_id
}

/** Il giro periodico, ogni minuto. Senza configurazione ElevenLabs non parte. */
export function avviaRichiamate(db: Db, log: Logger, config: Config): { ferma(): void } | null {
  if (!richiamataConfigurata(config)) {
    log.warn({}, 'ELEVENLABS_API_KEY / RICHIAMATA_AGENT_ID / PHONE_NUMBER_ID mancanti: richiamate non avviate')
    return null
  }
  let fermato = false
  let timer: NodeJS.Timeout | null = setTimeout(() => void giro(), 30_000)
  async function giro(): Promise<void> {
    if (fermato) return
    try {
      await eseguiRichiamate(db, log, config)
    } catch (errore) {
      log.error({ err: errore instanceof Error ? errore.message : String(errore) }, 'giro delle richiamate fallito')
    } finally {
      if (!fermato) timer = setTimeout(() => void giro(), 60_000)
    }
  }
  log.info({}, 'giro delle richiamate avviato')
  return {
    ferma() {
      fermato = true
      if (timer) clearTimeout(timer)
    },
  }
}

export const TENTATIVI_NOME = 2

export type EsitoVerificaNome =
  | 'corrisponde'
  | 'non_corrisponde'
  | 'troppi_tentativi'
  | 'nessun_nome_in_archivio'
  | 'richiamata_sconosciuta'

/**
 * Durante una richiamata: chi ha risposto è la persona dell'ordine? I nomi
 * in archivio non escono mai di qui: all'agente arriva solo l'esito, così
 * non può suggerirli né lasciarseli sfuggire con chi ha risposto.
 *
 * Fonti, in quest'ordine di autorità: intestatari di spedizione e di
 * fatturazione dell'ordine del ticket, poi il nome lasciato dal cliente nel
 * ticket (form dei siti, telefono) per i ticket senza ordine.
 */
export async function verificaNomeRichiamata(
  db: Db,
  conversationId: string,
  nome: string,
): Promise<{ esito: EsitoVerificaNome; tentativi_rimasti?: number }> {
  const [r] = await db<{ thread_id: string; order_id: string | null }[]>`
    select r.thread_id, t.order_id
    from richiamata_tentativo rt
    join richiamata r on r.id = rt.richiamata_id
    join thread t on t.id = r.thread_id
    where rt.conversation_id = ${conversationId}
  `
  if (!r) return { esito: 'richiamata_sconosciuta' }

  const [conteggio] = await db<{ falliti: number }[]>`
    select count(*)::int as falliti from voice_log
    where conversation_id = ${conversationId} and tool = 'verifica-nome' and esito = 'non_corrisponde'
  `
  const falliti = conteggio?.falliti ?? 0
  if (falliti >= TENTATIVI_NOME) return { esito: 'troppi_tentativi' }

  const righe = await db<{ nome: string | null }[]>`
    select o.shipping_address->>'nome' as nome from "order" o where o.id = ${r.order_id}
    union all
    select o.billing_address->>'nome' from "order" o where o.id = ${r.order_id}
    union all
    select m.raw->>'nome' from message m
    where m.thread_id = ${r.thread_id} and m.direction = 'in' and m.author_kind = 'customer' and m.raw->>'nome' is not null
  `
  const candidati = righe.map((x) => x.nome).filter((n): n is string => !!n && n.trim().length > 0)
  if (candidati.length === 0) return { esito: 'nessun_nome_in_archivio' }

  if (nomeCorrisponde(nome, candidati)) return { esito: 'corrisponde' }
  return { esito: 'non_corrisponde', tentativi_rimasti: Math.max(0, TENTATIVI_NOME - falliti - 1) }
}
