import type { Config } from '../../config.js'
import type { Db } from '../../db/index.js'
import type { Logger } from '../../logger.js'
import { check as verificaPolicy } from '../../core/policy.js'
import {
  decidiRisposta,
  leggiAutomazione,
  modelloSpedibile,
  notaChiusura,
  notaRisposta,
  puoChiudere,
  trovaAutomazione,
  type Automazione,
  type ContestoMessaggio,
  type RigaAutomazione,
} from '../../core/automazioni/regole.js'
import { inviaMessaggioMirakl } from '../mirakl/invia.js'

/**
 * Gli effetti delle automazioni (migrazione 0050): leggere le regole,
 * chiudere, rispondere, registrare.
 *
 * Due promesse valgono per tutto il file:
 *  - un'automazione non fa mai fallire l'ingestione: il messaggio è già
 *    salvato quando arriva qui, e qualunque errore lascia il ticket com'è,
 *    cioè in mano a un operatore;
 *  - ogni azione lascia una nota interna nel ticket e una riga in
 *    `automazione_esecuzione`, unica per regola e chiave: ripassare lo
 *    stesso messaggio non produce una seconda nota né una seconda risposta.
 */

const TABELLA_ASSENTE = '42P01'

/** Le regole valide. Se la migrazione 0050 non c'è ancora: nessuna regola. */
export async function caricaAutomazioni(db: Db, log: Logger): Promise<Automazione[]> {
  let righe: RigaAutomazione[]
  try {
    righe = await db<RigaAutomazione[]>`
      select id, codice, attiva, account_code, condizione, azione, parametri
      from automazione
      order by codice
    `
  } catch (errore) {
    if ((errore as { code?: string }).code === TABELLA_ASSENTE) return []
    throw errore
  }

  const valide: Automazione[] = []
  for (const r of righe) {
    const letta = leggiAutomazione(r)
    if (letta.ok) valide.push(letta.automazione)
    else log.warn({ codice: r.codice }, letta.motivo)
  }
  return valide
}

/** Come `caricaAutomazioni`, ma non lancia mai: le regole sono un di più. */
export async function caricaAutomazioniSicuro(db: Db, log: Logger): Promise<Automazione[]> {
  try {
    return await caricaAutomazioni(db, log)
  } catch (errore) {
    log.warn(
      { err: errore instanceof Error ? errore.message : String(errore) },
      'automazioni non caricate: nessuna regola attiva in questo giro',
    )
    return []
  }
}

async function registraAnomalia(
  db: Db,
  tipo: string,
  payload: Record<string, unknown>,
): Promise<void> {
  try {
    await db`insert into ingest_anomaly (tipo, payload) values (${tipo}, ${db.json(payload as never)})`
  } catch {
    /* se il database non risponde, lo dice già il log del chiamante */
  }
}

// ---------------------------------------------------------------------
// Chiudi: avvisi da archiviare senza risposta
// ---------------------------------------------------------------------

export type EsitoChiusura = 'chiuso' | 'gia_chiuso' | 'lasciato_aperto' | 'gia_fatto'

/**
 * Dopo che il messaggio è stato salvato (con `nonRiaprire`, quindi senza
 * rimettere il ticket in coda): chiude il ticket se dentro non c'è altro
 * da guardare.
 *
 * La nota interna si scrive solo quando la regola chiude davvero il
 * ticket. Se il ticket era già chiuso il messaggio si archivia in
 * silenzio e resta solo la riga nel registro: duecento avvisi all'anno
 * nello stesso ticket sarebbero duecento note che nessuno legge.
 */
export async function chiudiAutomatico(
  db: Db,
  log: Logger,
  automazione: Automazione,
  threadId: string,
  messageId: string,
): Promise<EsitoChiusura> {
  const esito = await db.begin(async (tx) => {
    const [thread] = await tx<{ state: string; account_code: string }[]>`
      select t.state, ca.code as account_code
      from thread t join channel_account ca on ca.id = t.account_id
      where t.id = ${threadId}
      for update of t
    `
    if (!thread) return 'gia_fatto' as const

    let decisione: Exclude<EsitoChiusura, 'gia_fatto'>
    if (thread.state === 'closed') {
      decisione = 'gia_chiuso'
    } else {
      // I messaggi del cliente dopo la nostra ultima risposta vera.
      const inAttesa = await tx<{ oggetto: string | null; mittente: string | null }[]>`
        select m.raw->>'subject' as oggetto,
               coalesce(m.raw->>'reply_to', m.raw->>'from') as mittente
        from message m
        where m.thread_id = ${threadId}
          and m.direction = 'in' and m.author_kind = 'customer' and not m.interno
          and m.sent_at > coalesce((
            select max(o.sent_at) from message o
            where o.thread_id = ${threadId} and o.direction = 'out' and not o.interno
          ), '-infinity'::timestamptz)
      `
      const contesto: ContestoMessaggio[] = inAttesa.map((m) => ({
        account_code: thread.account_code,
        oggetto: m.oggetto,
        mittente: m.mittente,
      }))
      decisione = puoChiudere(automazione, contesto) ? 'chiuso' : 'lasciato_aperto'
    }

    const [registrata] = await tx<{ id: string }[]>`
      insert into automazione_esecuzione (automazione_id, chiave, thread_id, message_id, esito)
      values (${automazione.id}, ${'messaggio:' + messageId}, ${threadId}, ${messageId}, ${decisione})
      on conflict (automazione_id, chiave) do nothing
      returning id
    `
    if (!registrata) return 'gia_fatto' as const

    if (decisione === 'chiuso') {
      await tx`
        insert into message (thread_id, direction, author_kind, body_text, interno, sent_at)
        values (${threadId}, 'out', 'agent', ${notaChiusura(automazione)}, true, now())
      `
      await tx`
        update thread set
          state = 'closed',
          tags = (select coalesce(array_agg(distinct x), '{}') from unnest(tags || ${automazione.parametri.tag}::text[]) x),
          updated_at = now()
        where id = ${threadId}
      `
    }
    return decisione
  })

  log.info({ automazione: automazione.codice, thread_id: threadId, esito }, 'automazione chiudi')
  return esito
}

// ---------------------------------------------------------------------
// Rispondi e chiudi: risposta con un modello, una volta per thread (Mirakl)
// ---------------------------------------------------------------------

export type EsitoRisposta = 'inviato' | 'errore' | 'non_applicabile'

/**
 * Da chiamare dopo che la sincronizzazione Mirakl ha inserito messaggi
 * nuovi in un thread.
 *
 * L'ordine è quello di `etichetta_reso`: prima si PRENOTA la riga nel
 * registro (`in_corso`, unica per thread), poi si spedisce. Due giri che
 * si sovrappongono non mandano due risposte; un errore dopo la
 * prenotazione non si ritenta da solo — meglio una risposta a mano che
 * il dubbio di averne mandate due.
 */
export async function rispondiAutomatico(
  db: Db,
  log: Logger,
  config: Config,
  automazioni: Automazione[],
  threadId: string,
  ora: Date = new Date(),
): Promise<EsitoRisposta> {
  if (!automazioni.some((a) => a.attiva && a.azione === 'rispondi_e_chiudi')) {
    return 'non_applicabile'
  }

  const [thread] = await db<{ subject: string | null; account_code: string; kind: string }[]>`
    select t.subject, ca.code as account_code, ca.kind
    from thread t join channel_account ca on ca.id = t.account_id
    where t.id = ${threadId}
  `
  if (!thread) return 'non_applicabile'

  const automazione = trovaAutomazione(automazioni, 'rispondi_e_chiudi', {
    account_code: thread.account_code,
    oggetto: thread.subject,
    mittente: null,
  })
  if (!automazione) return 'non_applicabile'

  const messaggi = await db<
    { direction: 'in' | 'out'; author_kind: string; interno: boolean; sent_at: Date }[]
  >`
    select direction, author_kind, interno, sent_at
    from message where thread_id = ${threadId}
  `
  const decisione = decidiRisposta(messaggi, ora, automazione.parametri.max_eta_ore)
  if (!decisione.rispondi) {
    log.debug(
      { automazione: automazione.codice, thread_id: threadId, motivo: decisione.motivo },
      'risposta automatica non dovuta',
    )
    return 'non_applicabile'
  }

  const [prenotata] = await db<{ id: string }[]>`
    insert into automazione_esecuzione (automazione_id, chiave, thread_id, esito)
    values (${automazione.id}, ${'thread:' + threadId}, ${threadId}, 'in_corso')
    on conflict (automazione_id, chiave) do nothing
    returning id
  `
  if (!prenotata) return 'non_applicabile'

  try {
    const [modello] = await db<{ body_tpl: string | null }[]>`
      select body_tpl from template where name = ${automazione.parametri.modello}
    `
    if (!modello) throw new Error(`modello «${automazione.parametri.modello}» non trovato nella tabella template`)
    const problema = modelloSpedibile(modello.body_tpl)
    if (problema) throw new Error(problema)
    const testo = modello.body_tpl!.trim()

    // Lo stesso controllo di un invio a mano (/threads/reply).
    const policy = verificaPolicy(thread.kind, testo)
    if (!policy.ok) {
      throw new Error(
        `il modello viola le regole del canale: ${policy.violazioni
          .filter((v) => v.bloccante)
          .map((v) => `${v.codice} («${v.porzione}»)`)
          .join(', ')}`,
      )
    }

    const inviato = await inviaMessaggioMirakl(db, log, config, {
      thread_id: threadId,
      agent_id: null,
      testo,
      destinatari: automazione.parametri.destinatari_mirakl,
    })

    await db.begin(async (tx) => {
      await tx`
        insert into message (thread_id, direction, author_kind, body_text, interno, sent_at)
        values (${threadId}, 'out', 'agent', ${notaRisposta(automazione)}, true, now())
      `
      await tx`
        update thread set
          state = 'closed',
          tags = (select coalesce(array_agg(distinct x), '{}') from unnest(tags || ${automazione.parametri.tag}::text[]) x),
          updated_at = now()
        where id = ${threadId}
      `
      await tx`
        update automazione_esecuzione set
          esito = 'inviato', risposta_id = ${inviato.message_id || null}, updated_at = now()
        where id = ${prenotata.id}
      `
    })

    log.info({ automazione: automazione.codice, thread_id: threadId }, 'risposta automatica inviata')
    return 'inviato'
  } catch (errore) {
    const messaggio = errore instanceof Error ? errore.message : String(errore)
    log.error(
      { automazione: automazione.codice, thread_id: threadId, err: messaggio },
      'risposta automatica non riuscita: il ticket resta a un operatore',
    )
    try {
      await db`
        update automazione_esecuzione set esito = 'errore', errore = ${messaggio}, updated_at = now()
        where id = ${prenotata.id}
      `
      await db`
        insert into message (thread_id, direction, author_kind, body_text, interno, sent_at)
        values (${threadId}, 'out', 'agent',
                ${`Risposta automatica NON inviata (regola ${automazione.codice}): ${messaggio}. Rispondere a mano.`},
                true, now())
      `
    } catch {
      /* la riga in ingest_anomaly qui sotto resta comunque */
    }
    await registraAnomalia(db, 'automazione_risposta_fallita', {
      automazione: automazione.codice,
      thread_id: threadId,
      errore: messaggio,
    })
    return 'errore'
  }
}
