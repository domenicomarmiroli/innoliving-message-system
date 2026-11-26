import type { Config } from '../../config.js'
import type { Db } from '../../db/index.js'
import type { Logger } from '../../logger.js'
import { prepare, type FilePronto } from '../../core/attachments/normalize.js'
import { scaricaAllegato } from '../../core/storage.js'
import { codiceProdottoDaTicket } from '../../core/sostituzione.js'
import {
  daGaranzia,
  daTesto,
  leggiConfigPartner,
  oggettoPartner,
  testoPartner,
  unisci,
  type ConfigAssistenzaPartner,
  type DatiPratica,
} from '../../core/assistenza-partner.js'
import { apriTicketCollegato } from './collega.js'

/**
 * Mail al centro assistenza esterno, dal ticket di garanzia (migrazione 0058).
 *
 * Parte come ticket collegato (`collega.ts`, tipo 'assistenza'): nuovo
 * ticket "in attesa" legato a quello del cliente, e la risposta del partner
 * si aggancia da sola quando conserva i nostri riferimenti della mail.
 * Testo e oggetto li compone sempre il worker, così il formato non cambia e
 * il partner può leggerlo in automatico: l'operatore aggiunge solo una nota.
 */

export class ErrorePartner extends Error {
  constructor(public status: number, message: string) {
    super(message)
  }
}

const MAX_ALLEGATI = 10

interface Riferimento { storage_path: string; nome_file: string; mime: string }

export interface AnteprimaPartner {
  configurato: boolean
  nome_partner: string
  destinatario: string | null
  oggetto: string
  testo: string
  dati: DatiPratica
  allegati: Riferimento[]
  /** Se la mail è già partita per questo ticket: il ticket collegato. */
  gia_inviato: { thread_id: string; numero: string | null; inviato_il: Date } | null
}

async function configPartner(db: Db): Promise<ConfigAssistenzaPartner> {
  const [r] = await db<{ value: unknown }[]>`select value from app_config where key = 'assistenza_partner'`
  return leggiConfigPartner(r?.value)
}

async function raccogli(db: Db, threadId: string, config: ConfigAssistenzaPartner) {
  const [t] = await db<{ numero: string | null; subject: string | null; valore_scontrino: string | null }[]>`
    select numero::text as numero, subject, valore_scontrino::text as valore_scontrino
    from thread where id = ${threadId}
  `
  if (!t) throw new ErrorePartner(404, 'ticket non trovato')

  const messaggi = await db<{ raw: Record<string, unknown> | null; testo: string | null }[]>`
    select raw, body_text as testo from message
    where thread_id = ${threadId} and direction = 'in' and author_kind = 'customer'
    order by sent_at
  `
  const conGaranzia = messaggi.find((m) => m.raw?.['garanzia'] && typeof m.raw['garanzia'] === 'object')
  const primo = messaggi[0]
  const email = messaggi.map((m) => m.raw?.['from']).find((v): v is string => typeof v === 'string' && v.includes('@')) ?? null
  const nome = messaggi.map((m) => m.raw?.['nome']).find((v): v is string => typeof v === 'string' && !!v.trim()) ?? null

  const dati = unisci(
    daGaranzia(conGaranzia?.raw?.['garanzia'] as Record<string, unknown> | undefined),
    daTesto(conGaranzia?.testo ?? primo?.testo ?? null),
    {
      numero_ticket: t.numero,
      nome,
      email,
      codice: codiceProdottoDaTicket(messaggi, t.subject),
      valore_pagato: t.valore_scontrino ? Number(t.valore_scontrino) : null,
    },
  )

  const allegati = await db<Riferimento[]>`
    select a.storage_path, a.nome_file, a.mime
    from attachment a join message m on m.id = a.message_id
    where m.thread_id = ${threadId} and m.direction = 'in' and m.author_kind = 'customer'
      and a.storage_path is not null
      and (a.mime like 'image/%' or a.mime = 'application/pdf')
    order by m.sent_at, a.nome_file
    limit ${MAX_ALLEGATI}
  `

  const gia = config.email
    ? await db<{ thread_id: string; numero: string | null; inviato_il: Date }[]>`
        select c.id as thread_id, c.numero::text as numero, c.created_at as inviato_il
        from thread c
        where c.linked_thread_id = ${threadId} and 'collegato-assistenza' = any(c.tags)
          and exists (select 1 from message m where m.thread_id = c.id and m.direction = 'out'
                      and lower(m.raw->>'to') = lower(${config.email}))
        order by c.created_at desc limit 1
      `
    : []

  return { dati, allegati, gia_inviato: gia[0] ?? null }
}

export async function anteprimaPartner(db: Db, threadId: string, nota: string | null = null): Promise<AnteprimaPartner> {
  const config = await configPartner(db)
  const { dati, allegati, gia_inviato } = await raccogli(db, threadId, config)
  return {
    configurato: Boolean(config.email),
    nome_partner: config.nome,
    destinatario: config.email,
    oggetto: oggettoPartner(config, dati),
    testo: testoPartner(dati, nota, allegati.length),
    dati,
    allegati,
    gia_inviato,
  }
}

export async function inviaAlPartner(
  db: Db,
  log: Logger,
  config: Config,
  r: { thread_id: string; agent_id: string | null; nota: string | null; reinvia: boolean },
): Promise<{ thread_id: string; message_id: string; allegati: number; allegati_saltati: string[] }> {
  const cp = await configPartner(db)
  if (!cp.email) throw new ErrorePartner(503, "Manca l'indirizzo del centro assistenza (app_config.assistenza_partner).")
  const { dati, allegati, gia_inviato } = await raccogli(db, r.thread_id, cp)
  if (gia_inviato && !r.reinvia) {
    throw new ErrorePartner(409, `Richiesta già inviata al centro assistenza (ticket #${gia_inviato.numero ?? ''}).`)
  }

  // Un allegato che non si scarica o non passa i controlli non blocca la
  // richiesta: si salta e l'operatore lo vede nella risposta.
  const file: FilePronto[] = []
  const saltati: string[] = []
  for (const a of allegati) {
    try {
      const contenuto = await scaricaAllegato(config, a.storage_path)
      const esito = await prepare('email', { nome_file: a.nome_file, mime: a.mime, contenuto })
      if (esito.ok) file.push(esito)
      else saltati.push(a.nome_file)
    } catch (e) {
      log.warn({ thread_id: r.thread_id, file: a.nome_file, err: e instanceof Error ? e.message : String(e) }, 'allegato per il centro assistenza saltato')
      saltati.push(a.nome_file)
    }
  }

  const esito = await apriTicketCollegato(db, log, config, {
    thread_id: r.thread_id,
    agent_id: r.agent_id,
    destinatario: cp.email,
    oggetto: oggettoPartner(cp, dati),
    testo: testoPartner(dati, r.nota, file.length),
    tipo: 'assistenza',
    allegati: file,
  })
  return { thread_id: esito.thread_id, message_id: esito.message_id, allegati: file.length, allegati_saltati: saltati }
}
