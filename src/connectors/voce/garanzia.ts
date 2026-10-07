import type { Config } from '../../config.js'
import type { Db } from '../../db/index.js'
import type { Logger } from '../../logger.js'
import { spedisci } from '../mail/spedizione.js'
import {
  TAG_ATTESA_REGISTRAZIONE,
  chiaveCollegamento,
  emailRegistrazioneGaranzia,
  linkPortale,
} from '../../core/garanzia/collegamento.js'

/**
 * Dopo una telefonata per un prodotto in garanzia: email al cliente con il
 * link al portale garanzie del brand, e ticket in attesa della
 * registrazione. Quando il cliente registra il prodotto, il portale chiama
 * `POST /clienti/ticket/:id/garanzia` e il ticket torna aperto.
 *
 * L'indirizzo del portale sta nella configurazione del canale
 * `garanzia-<brand>` (`config.portale_url`, migrazione 0041), non nel
 * codice. Un brand senza portale (oggi Bimar, che passa dal centro
 * assistenza) non riceve l'email: il ticket resta un normale ticket aperto.
 */

export type EsitoRegistrazione =
  | { inviata: true }
  | { inviata: false; motivo: 'senza_email' | 'senza_portale' | 'non_configurato' | 'errore_invio' }

export async function avviaRegistrazioneGaranzia(
  db: Db,
  log: Logger,
  config: Config,
  r: { thread_id: string; numero: string; email: string | null; nome: string | null; brand: string; prodotto: string | null },
): Promise<EsitoRegistrazione> {
  if (!r.email) return { inviata: false, motivo: 'senza_email' }
  if (!config.CONTATTO_TOKEN) return { inviata: false, motivo: 'non_configurato' }

  const [canale] = await db<{ marchio: string; portale_url: string | null }[]>`
    select coalesce(config->>'marchio', regexp_replace(display_name, '^Garanzie ', '')) as marchio,
           config->>'portale_url' as portale_url
    from channel_account
    where code = ${`garanzia-${r.brand}`} and active
  `
  if (!canale?.portale_url) return { inviata: false, motivo: 'senza_portale' }

  const link = linkPortale(canale.portale_url, r.thread_id, chiaveCollegamento(r.thread_id, config.CONTATTO_TOKEN))
  const { oggetto, testo } = emailRegistrazioneGaranzia({
    numero: r.numero,
    nome: r.nome,
    marchio: canale.marchio,
    prodotto: r.prodotto,
    link,
  })
  // La stessa casella da cui partono le risposte ai ticket telefonici
  // (connectors/voce/ticket.ts): una risposta del cliente a questa email
  // torna nello stesso ticket.
  const trasporto = config.MS_MAILBOX ? 'graph' : 'imap'

  try {
    const inviato = await spedisci(config, log, trasporto, { a: r.email, oggetto, testo })
    await db.begin(async (tx) => {
      await tx`
        insert into message (
          thread_id, direction, author_kind, external_id, rfc822_id, body_text, sent_at, delivery_state, raw
        ) values (
          ${r.thread_id}, 'out', 'agent', ${inviato.rfc822_id}, ${inviato.rfc822_id}, ${testo}, now(), 'inviato',
          ${tx.json({ to: r.email, subject: oggetto, accepted: inviato.accettati, trasporto, automatico: 'registrazione_garanzia' } as never)}
        )
        on conflict do nothing
      `
      // In attesa del cliente: il ticket non occupa la coda dell'assistenza
      // finché la registrazione non arriva.
      await tx`
        update thread set
          state = 'pending_customer',
          tags = (select array(select distinct unnest(tags || array[${TAG_ATTESA_REGISTRAZIONE}::text, 'garanzia'::text]))),
          updated_at = now()
        where id = ${r.thread_id}
      `
    })
    log.info({ thread_id: r.thread_id, brand: r.brand }, 'email di registrazione garanzia inviata')
    return { inviata: true }
  } catch (errore) {
    log.error(
      { thread_id: r.thread_id, err: errore instanceof Error ? errore.message : String(errore) },
      'invio email di registrazione garanzia fallito: il ticket resta aperto',
    )
    return { inviata: false, motivo: 'errore_invio' }
  }
}
