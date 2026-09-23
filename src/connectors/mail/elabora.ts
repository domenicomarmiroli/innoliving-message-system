import type { Config } from '../../config.js'
import type { Db } from '../../db/index.js'
import type { Logger } from '../../logger.js'
import { aggancia } from './aggancia.js'
import { classificaEsalvaIntento } from '../../core/ai/intento.js'
import { registraAnnullamento } from './annullamenti.js'
import { registraAvviso, registraNotifica } from './notifica.js'
import { registraOptOut } from './optout.js'
import { registraReclamo } from './reclami.js'
import { registraReso } from './resi.js'
import { registraRimborso } from './rimborsi.js'
import { classificaMittente, riconosci } from './riconosci.js'
import type { Regole } from './regole.js'
import type { EmailGrezza } from './tipi.js'
import { upsertEmail } from './upsert.js'

/**
 * Cosa fare di una email, una volta che è stata letta e analizzata.
 *
 * Sta qui, e non dentro il ciclo IMAP, perché **il trasporto non deve
 * avere opinioni sul contenuto**: IMAP e Microsoft Graph consegnano gli
 * stessi byte RFC822, e da quel punto in poi il comportamento dev'essere
 * identico. Tenerne due copie significherebbe correggere ogni bug due
 * volte — e accorgersi della seconda solo quando un cliente scrive alla
 * casella sbagliata.
 *
 * Più generi di posta, e solo uno diventa un ticket nuovo:
 *  - escluso: posta di servizio, non entra e basta.
 *  - avviso: garanzia dalla A alla Z, richieste di rimborso. Non li
 *    scrive il cliente ma sono la cosa più urgente che passa di qui, e
 *    per la A-to-Z non esiste API: questa email è l'unico modo di
 *    saperlo.
 *  - reso: richiesta di reso autorizzata da Amazon (RETURN_REQUEST). Si
 *    annota sulla conversazione dell'ordine, con corriere e tracking del
 *    rientro quando presenti.
 *  - rimborso: rimborso emesso (REFUND_ISSUED). Si annota sull'ordine; a
 *    differenza del reso può ripetersi (rimborsi parziali), quindi
 *    l'importo sull'ordine è una somma, non l'ultimo visto.
 *  - reclamo: Garanzia dalla A alla Z (A_Z_CLAIM_RESPONDENT_NOTIFY).
 *    Pesa sulla salute dell'account venditore.
 *  - opt_out: l'acquirente ha disattivato i messaggi non richiesti
 *    (BUYER_OPTED_OUT_BSM_MESSAGES). Un solo reinvio automatico con
 *    "[Importante]"; se fallisce anche quello serve un operatore da
 *    Seller Central.
 *  - annullamento: richiesta di annullamento prima della spedizione
 *    (BRC_SELLER_NOTIFICATION). Urgente per la logistica.
 *  - notifica: avvisi di mancata consegna. Non sono richieste, ma dicono
 *    che una nostra risposta non è arrivata.
 *  - messaggio: tutto il resto, compresa la posta diretta di un cliente
 *    che non passa da nessun marketplace.
 */

export type EsitoElaborazione =
  | 'ignorata'
  | 'avviso'
  | 'reso'
  | 'rimborso'
  | 'reclamo'
  | 'opt_out'
  | 'annullamento'
  | 'notifica'
  | 'inserito'
  | 'gia_presente'

export async function elaboraEmail(
  db: Db,
  log: Logger,
  config: Config,
  email: EmailGrezza,
  { regole, casella, opzioni }: Regole,
): Promise<EsitoElaborazione> {
  const genere = classificaMittente(email, opzioni, regole)

  // Le notifiche di Amazon parlano di ordini Amazon: si annotano
  // sull'account di quel canale, non su quello della casella che le ha
  // ricevute. La casella resta il ripiego quando quel canale non è
  // configurato.
  const canale = regole.find((r) => r.kind === 'amazon') ?? casella

  if (genere === 'escluso') return 'ignorata'

  if (genere === 'avviso') {
    await registraAvviso(db, log, email, canale.account_id, canale.order_id_pattern, opzioni)
    return 'avviso'
  }

  if (genere === 'reso') {
    await registraReso(db, log, email, canale.account_id, canale.order_id_pattern, opzioni)
    return 'reso'
  }

  if (genere === 'rimborso') {
    await registraRimborso(db, log, email, canale.account_id, canale.order_id_pattern, opzioni)
    return 'rimborso'
  }

  if (genere === 'reclamo') {
    await registraReclamo(db, log, email, canale.account_id, canale.order_id_pattern, opzioni)
    return 'reclamo'
  }

  if (genere === 'opt_out') {
    await registraOptOut(db, log, config, email, canale.account_id, canale.order_id_pattern)
    return 'opt_out'
  }

  if (genere === 'annullamento') {
    await registraAnnullamento(db, log, email, canale.account_id, canale.order_id_pattern, opzioni)
    return 'annullamento'
  }

  if (genere === 'notifica') {
    await registraNotifica(db, log, email, casella.account_id, canale.order_id_pattern)
    return 'notifica'
  }

  const ric = riconosci(email, regole, casella)
  const agg = await aggancia(db, email, ric)
  const scritto = await upsertEmail(db, log, config, email, ric, agg, opzioni)

  // Solo al primo messaggio di un ticket nuovo: le risposte successive
  // non cambiano l'argomento della conversazione, e classificare ad ogni
  // giro sarebbe una chiamata AI sprecata.
  if (scritto.esito === 'inserito' && scritto.nuovo_thread) {
    await classificaEsalvaIntento(db, log, config, scritto.thread_id, scritto.corpo_testo)
  }

  return scritto.esito === 'inserito' ? 'inserito' : 'gia_presente'
}

/** I contatori di un giro di lettura, comuni ai due trasporti. */
export interface ContatoriGenere {
  inserite: number
  gia_presenti: number
  ignorate: number
  notifiche: number
  avvisi: number
  resi: number
  rimborsi: number
  reclami: number
  opt_out: number
  annullamenti: number
}

export function contatoriVuoti(): ContatoriGenere {
  return {
    inserite: 0,
    gia_presenti: 0,
    ignorate: 0,
    notifiche: 0,
    avvisi: 0,
    resi: 0,
    rimborsi: 0,
    reclami: 0,
    opt_out: 0,
    annullamenti: 0,
  }
}

export function conta(c: ContatoriGenere, esito: EsitoElaborazione): void {
  switch (esito) {
    case 'inserito':
      c.inserite += 1
      break
    case 'gia_presente':
      c.gia_presenti += 1
      break
    case 'ignorata':
      c.ignorate += 1
      break
    case 'notifica':
      c.notifiche += 1
      break
    case 'avviso':
      c.avvisi += 1
      break
    case 'reso':
      c.resi += 1
      break
    case 'rimborso':
      c.rimborsi += 1
      break
    case 'reclamo':
      c.reclami += 1
      break
    case 'opt_out':
      c.opt_out += 1
      break
    case 'annullamento':
      c.annullamenti += 1
      break
  }
}
