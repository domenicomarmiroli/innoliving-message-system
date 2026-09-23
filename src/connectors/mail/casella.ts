import type { Db } from '../../db/index.js'

/**
 * Quale trasporto usa una casella.
 *
 * Due caselle convivono durante la migrazione: quella storica su Gmail
 * (IMAP in lettura, SMTP in invio) e quella aziendale su Microsoft 365
 * (Graph per entrambe). Sono due righe `channel_account` con
 * `kind='email'`, distinte dalla colonna `transport` — prevista fin dalla
 * migrazione 0001 e già valorizzata ('imap' sulla casella Gmail, 'api'
 * sugli operatori Mirakl e su Shopify).
 *
 * Qualunque valore diverso da 'graph' vale 'imap': è il comportamento di
 * prima, e le righe esistenti non vanno toccate.
 *
 * Perché serve un discriminante esplicito: prima bastava "l'unica riga
 * con kind='email'", e infatti sia `caricaRegole()` sia
 * `apriTicketCollegato()` la cercavano così, con un `find`/`limit 1`
 * senza ordinamento. Con due righe quella scelta diventa arbitraria —
 * dipende dall'ordine che restituisce Postgres — e un ticket della
 * casella Gmail potrebbe finire agganciato all'account Microsoft. Non
 * darebbe nessun errore: si vedrebbe solo, più tardi, come risposte
 * partite dall'indirizzo sbagliato.
 */

export type Trasporto = 'imap' | 'graph'

export function trasportoDi(colonna: string | null | undefined): Trasporto {
  return colonna === 'graph' ? 'graph' : 'imap'
}

export interface CasellaAttiva {
  account_id: string
  code: string
  sla_minutes: number
  trasporto: Trasporto
}

export async function caselleAttive(db: Db): Promise<CasellaAttiva[]> {
  const righe = await db<
    { id: string; code: string; sla_minutes: number; transport: string | null }[]
  >`
    select id, code, sla_minutes, transport
    from channel_account
    where kind = 'email' and active
    order by code
  `
  return righe.map((r) => ({
    account_id: r.id,
    code: r.code,
    sla_minutes: r.sla_minutes,
    trasporto: trasportoDi(r.transport),
  }))
}

/**
 * La casella di un trasporto. Errore esplicito se non c'è: meglio un
 * messaggio che dice cosa manca di un comportamento che sceglie a caso.
 */
export async function casellaPerTrasporto(db: Db, trasporto: Trasporto): Promise<CasellaAttiva> {
  const caselle = await caselleAttive(db)
  const trovata = caselle.find((c) => c.trasporto === trasporto)
  if (!trovata) {
    throw new Error(
      `Nessuna casella attiva con transport='${trasporto}' in channel_account (kind='email'). ` +
        `Caselle attive: ${caselle.map((c) => `${c.code}(${c.trasporto})`).join(', ') || 'nessuna'}.`,
    )
  }
  return trovata
}

/**
 * Da quale casella rispondere, letto dal messaggio a cui si risponde.
 *
 * **Non dall'account del thread.** Un ticket Amazon ha come account
 * `amazon-it`, non la casella che ha ricevuto l'email: guardare lì non
 * direbbe da quale casella è entrato, e una risposta a un cliente che ci
 * ha scritto sulla casella Microsoft partirebbe da Gmail — rifiutata dal
 * relay del marketplace.
 *
 * Il chiamante passa il `raw` dello **stesso** messaggio da cui prende
 * il destinatario: così indirizzo e identità di invio vengono dalla
 * stessa riga e non possono divergere.
 *  - `casella`: scritto all'ingresso su ogni messaggio ricevuto;
 *  - `trasporto`: scritto sui nostri invii (serve ai ticket collegati,
 *    che nascono con un solo messaggio in uscita, e al reinvio opt-out).
 * Nessuno dei due = messaggio precedente alla migrazione = Gmail.
 */
export function trasportoDaRaw(raw: Record<string, unknown> | null | undefined): Trasporto {
  return raw?.['casella'] === 'graph' || raw?.['trasporto'] === 'graph' ? 'graph' : 'imap'
}
