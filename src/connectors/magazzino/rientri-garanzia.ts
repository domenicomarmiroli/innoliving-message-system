import type { Db } from '../../db/index.js'
import type { Logger } from '../../logger.js'
import { numeroTicketDaPratica, statoDaEsitoMagazzino } from '../../core/pratica/stati.js'
import { registraStatoPratica } from '../pratica/avvisi.js'
import { TAG_PACCO_RIENTRATO, type Rientro } from './rientri.js'

/**
 * Rientri in garanzia dal tool di magazzino → stato della pratica.
 *
 * Il collegamento è il NOSTRO numero di ticket nel campo "pratica" del
 * rientro (scelta del 08/10: le pratiche si gestiscono in questo sistema).
 * I rientri con il numero del partner ("GGF-…") restano fuori: non hanno
 * un ticket nostro a cui legarsi.
 *
 * L'esito è già deciso alla scansione: il cliente riceve un solo avviso
 * ("arrivato, esito: sostituzione") invece di due. Il ticket torna aperto:
 * dopo il rientro c'è sempre un'azione (spedire, riparare, rispondere).
 */
export async function elaboraRientriGaranzia(
  db: Db,
  log: Logger,
  rientri: Rientro[],
): Promise<{ collegati: number; senza_ticket: number }> {
  let collegati = 0
  let senzaTicket = 0
  for (const r of rientri) {
    const numero = numeroTicketDaPratica(r.pratica)
    if (numero === null) continue
    const [t] = await db<{ id: string }[]>`
      select id from thread where numero = ${numero} and linked_thread_id is null
    `
    if (!t) {
      senzaTicket++
      continue
    }
    const stato = statoDaEsitoMagazzino(r.action)
    const nuovo = await registraStatoPratica(db, {
      thread_id: t.id,
      stato,
      origine: 'magazzino',
      dettagli: { barcode: r.barcode, esito_magazzino: r.action ?? null, scansione: r.created_at },
    })
    if (!nuovo) continue
    await db`
      update thread set
        tags = (select array(select distinct unnest(tags || ${[TAG_PACCO_RIENTRATO]}::text[]))),
        state = 'open', updated_at = now()
      where id = ${t.id}
    `
    collegati++
  }
  if (senzaTicket > 0) log.warn({ senza_ticket: senzaTicket }, 'rientri in garanzia con un numero di ticket inesistente')
  return { collegati, senza_ticket: senzaTicket }
}
