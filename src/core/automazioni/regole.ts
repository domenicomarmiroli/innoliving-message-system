import { dominioCombacia, dominioDi } from '../../connectors/mail/riconosci.js'

/**
 * Le automazioni sui ticket: regole che agiscono da sole su certi
 * messaggi in arrivo (migrazione 0050).
 *
 * Qui solo le decisioni, senza database né rete: cosa combacia, quando
 * si può chiudere, quando si può rispondere. Gli effetti stanno in
 * `connectors/automazioni/`.
 *
 * Le regole vengono dal database (regola 7): nel codice non c'è nessun
 * oggetto, mittente o modello di nessun marketplace.
 */

export type AzioneAutomazione = 'chiudi' | 'rispondi_e_chiudi' | 'avviso_spedizione'
export type DestinatarioAutomatico = 'CUSTOMER' | 'OPERATOR'

export interface CondizioneAutomazione {
  oggetto_inizia_per: string[]
  oggetto_uguale: string[]
  mittente_dominio: string[]
  /** Solo avviso_spedizione: gli stati di spedizione che fanno scattare l'avviso. */
  stati_spedizione: string[]
  /**
   * Solo avviso_spedizione: domini delle email a cui NON si scrive, perché
   * sono un relay che non consegna (es. gli ordini Amazon via connettore) o
   * l'indirizzo del marketplace invece che quello del cliente.
   */
  domini_esclusi: string[]
}

export interface ParametriAutomazione {
  nota: string | null
  modello: string | null
  destinatari_mirakl: DestinatarioAutomatico[]
  tag: string[]
  max_eta_ore: number
  /** Solo avviso_spedizione: stato di spedizione → nome del modello (tabella template). */
  modelli: Record<string, string>
}

export interface Automazione {
  id: string
  codice: string
  attiva: boolean
  account_code: string | null
  condizione: CondizioneAutomazione
  azione: AzioneAutomazione
  parametri: ParametriAutomazione
}

export interface RigaAutomazione {
  id: string
  codice: string
  attiva: boolean
  account_code: string | null
  condizione: unknown
  azione: string
  parametri: unknown
}

/** Una risposta automatica a un messaggio vecchio confonde più che aiutare. */
const MAX_ETA_ORE_PREDEFINITA = 48

function stringhe(v: unknown): string[] {
  if (!Array.isArray(v)) return []
  return v
    .filter((x): x is string => typeof x === 'string')
    .map((x) => x.trim())
    .filter((x) => x.length > 0)
}

function oggetto(v: unknown): Record<string, unknown> {
  return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {}
}

/**
 * Dalla riga del database alla regola, oppure il motivo per cui non vale.
 *
 * Una regola senza condizioni sull'oggetto NON scatta mai: un errore di
 * configurazione non deve trasformarsi in "chiudi tutto".
 */
export function leggiAutomazione(
  riga: RigaAutomazione,
): { ok: true; automazione: Automazione } | { ok: false; motivo: string } {
  const c = oggetto(riga.condizione)
  const condizione: CondizioneAutomazione = {
    oggetto_inizia_per: stringhe(c.oggetto_inizia_per),
    oggetto_uguale: stringhe(c.oggetto_uguale),
    mittente_dominio: stringhe(c.mittente_dominio),
    stati_spedizione: stringhe(c.stati_spedizione),
    domini_esclusi: stringhe(c.domini_esclusi),
  }

  if (riga.azione !== 'chiudi' && riga.azione !== 'rispondi_e_chiudi' && riga.azione !== 'avviso_spedizione') {
    return { ok: false, motivo: `automazione ${riga.codice}: azione sconosciuta '${riga.azione}'` }
  }
  if (riga.azione === 'avviso_spedizione') {
    if (condizione.stati_spedizione.length === 0) {
      return { ok: false, motivo: `automazione ${riga.codice}: nessuno stato di spedizione indicato` }
    }
  } else if (condizione.oggetto_inizia_per.length === 0 && condizione.oggetto_uguale.length === 0) {
    return { ok: false, motivo: `automazione ${riga.codice}: nessuna condizione sull'oggetto` }
  }

  const p = oggetto(riga.parametri)
  const destinatari = stringhe(p.destinatari_mirakl).filter(
    (d): d is DestinatarioAutomatico => d === 'CUSTOMER' || d === 'OPERATOR',
  )
  const parametri: ParametriAutomazione = {
    nota: typeof p.nota === 'string' && p.nota.trim() ? p.nota.trim() : null,
    modello: typeof p.modello === 'string' && p.modello.trim() ? p.modello.trim() : null,
    destinatari_mirakl: destinatari.length > 0 ? destinatari : ['CUSTOMER'],
    tag: stringhe(p.tag),
    max_eta_ore:
      typeof p.max_eta_ore === 'number' && p.max_eta_ore > 0
        ? p.max_eta_ore
        : MAX_ETA_ORE_PREDEFINITA,
    modelli: Object.fromEntries(
      Object.entries(oggetto(p.modelli)).filter(
        (e): e is [string, string] => typeof e[1] === 'string' && e[1].trim().length > 0,
      ),
    ),
  }

  if (riga.azione === 'rispondi_e_chiudi' && !parametri.modello) {
    return { ok: false, motivo: `automazione ${riga.codice}: manca il modello da inviare` }
  }
  if (riga.azione === 'avviso_spedizione') {
    const senza = condizione.stati_spedizione.filter((st) => !parametri.modelli[st])
    if (senza.length > 0) {
      return { ok: false, motivo: `automazione ${riga.codice}: manca il modello per ${senza.join(', ')}` }
    }
  }

  return {
    ok: true,
    automazione: {
      id: riga.id,
      codice: riga.codice,
      attiva: riga.attiva,
      account_code: riga.account_code,
      condizione,
      azione: riga.azione,
      parametri,
    },
  }
}

export interface ContestoMessaggio {
  account_code: string
  oggetto: string | null
  /** Il mittente così com'è ("Nome <tizio@esempio.it>" va bene). Null su Mirakl. */
  mittente: string | null
}

/** L'oggetto combacia? Senza distinguere maiuscole e spazi ai bordi. */
export function oggettoCombacia(c: CondizioneAutomazione, oggettoMsg: string | null): boolean {
  if (!oggettoMsg) return false
  const o = oggettoMsg.trim().toLowerCase()
  if (c.oggetto_uguale.some((x) => x.toLowerCase() === o)) return true
  return c.oggetto_inizia_per.some((x) => o.startsWith(x.toLowerCase()))
}

/** Il messaggio rientra in questa regola? Non guarda l'interruttore. */
export function combacia(a: Automazione, m: ContestoMessaggio): boolean {
  if (a.account_code && a.account_code !== m.account_code) return false
  if (!oggettoCombacia(a.condizione, m.oggetto)) return false
  if (a.condizione.mittente_dominio.length > 0) {
    const dominio = dominioDi(m.mittente)
    if (!dominio) return false
    if (!a.condizione.mittente_dominio.some((r) => dominioCombacia(dominio, r))) return false
  }
  return true
}

/** La prima regola ACCESA, di quell'azione, che combacia con il messaggio. */
export function trovaAutomazione(
  lista: Automazione[],
  azione: AzioneAutomazione,
  m: ContestoMessaggio,
): Automazione | null {
  return lista.find((a) => a.attiva && a.azione === azione && combacia(a, m)) ?? null
}

/**
 * Si può chiudere il ticket?
 *
 * Solo se TUTTI i messaggi del cliente ancora in attesa (quelli dopo la
 * nostra ultima risposta) sono di questa regola. Lo stesso mittente di
 * un marketplace può mettere nello stesso ticket avvisi da archiviare e
 * cose da leggere (es. "Nuova risposta al reclamo"): chiudere per un
 * avviso nasconderebbe il reclamo.
 */
export function puoChiudere(
  a: Automazione,
  inAttesa: ContestoMessaggio[],
): boolean {
  return inAttesa.length > 0 && inAttesa.every((m) => combacia(a, m))
}

export interface MessaggioThread {
  direction: 'in' | 'out'
  author_kind: string
  interno: boolean
  sent_at: Date
}

export type DecisioneRisposta =
  | { rispondi: true }
  | { rispondi: false; motivo: 'nessuna_richiesta' | 'gia_risposto' | 'scritto_dal_cliente' | 'troppo_vecchio' }

/**
 * Si può mandare la risposta automatica in questo thread?
 *
 * - c'è almeno un messaggio in arrivo;
 * - nessuna nostra risposta, nemmeno a mano: se qualcuno ha già risposto
 *   il ticket è in mano a una persona;
 * - tutto ciò che è arrivato è del marketplace (author_kind 'system'):
 *   se il cliente ha scritto con parole sue serve un operatore;
 * - l'ultimo arrivo è recente: accendere la regola non deve far partire
 *   risposte a richieste di settimane fa.
 */
export function decidiRisposta(
  messaggi: MessaggioThread[],
  ora: Date,
  maxEtaOre: number,
): DecisioneRisposta {
  const veri = messaggi.filter((m) => !m.interno)
  const arrivi = veri.filter((m) => m.direction === 'in')
  if (arrivi.length === 0) return { rispondi: false, motivo: 'nessuna_richiesta' }
  if (veri.some((m) => m.direction === 'out')) return { rispondi: false, motivo: 'gia_risposto' }
  if (arrivi.some((m) => m.author_kind !== 'system')) {
    return { rispondi: false, motivo: 'scritto_dal_cliente' }
  }
  const ultimo = Math.max(...arrivi.map((m) => m.sent_at.getTime()))
  if (ora.getTime() - ultimo > maxEtaOre * 3_600_000) {
    return { rispondi: false, motivo: 'troppo_vecchio' }
  }
  return { rispondi: true }
}

/** Testo della nota interna dopo una risposta automatica. */
export function notaRisposta(a: Automazione): string {
  return (
    a.parametri.nota ??
    `Risposta automatica inviata con il modello «${a.parametri.modello}», ticket chiuso (regola ${a.codice}).`
  )
}

/** Testo della nota interna dopo una chiusura automatica. */
export function notaChiusura(a: Automazione): string {
  return a.parametri.nota ?? `Chiuso in automatico (regola ${a.codice}).`
}

/**
 * Il modello si può spedire così com'è? Un segnaposto non compilato
 * (`{{cliente.nome}}`) arriverebbe tale e quale al cliente.
 */
export function modelloSpedibile(testo: string | null | undefined): string | null {
  if (!testo || !testo.trim()) return 'il modello è vuoto'
  if (/\{\{[^}]*\}\}/.test(testo)) return 'il modello contiene campi da compilare ({{...}})'
  return null
}
