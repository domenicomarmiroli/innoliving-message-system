/**
 * Richiamata del cliente con l'agente vocale: la parte pura.
 *
 * Regole chieste da Domenico (07/10): l'operatore fa partire la chiamata
 * dal ticket; se il cliente non risponde si riprova durante la giornata,
 * attendendo fra una e due ore; MAI prima delle 8:00 né dopo le 21:00 (ora
 * italiana). La fascia e le attese stanno in `app_config.voce_richiamate`
 * (migrazione 0042): qui c'è solo la regola.
 */

export interface RegoleRichiamata {
  /** "HH:MM", ora italiana. */
  ora_inizio: string
  ora_fine: string
  attesa_min_minuti: number
  attesa_max_minuti: number
  max_tentativi: number
  /**
   * Una chiamata non parte se mancano meno di questi minuti alla fine
   * della fascia: una telefonata iniziata alle 20:59 finirebbe dopo le 21.
   */
  margine_fine_minuti: number
}

export const REGOLE_PREDEFINITE: RegoleRichiamata = {
  ora_inizio: '08:00',
  ora_fine: '21:00',
  attesa_min_minuti: 60,
  attesa_max_minuti: 120,
  max_tentativi: 5,
  margine_fine_minuti: 10,
}

const FUSO = 'Europe/Rome'

interface Locale {
  anno: number
  mese: number
  giorno: number
  minutiDelGiorno: number
}

function locale(d: Date): Locale {
  const p = Object.fromEntries(
    new Intl.DateTimeFormat('en-GB', {
      timeZone: FUSO,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      hourCycle: 'h23',
    })
      .formatToParts(d)
      .map((x) => [x.type, x.value]),
  )
  return {
    anno: Number(p.year),
    mese: Number(p.month),
    giorno: Number(p.day),
    minutiDelGiorno: Number(p.hour) * 60 + Number(p.minute),
  }
}

/** L'istante UTC di un'ora italiana di un certo giorno, ora legale compresa. */
function istanteItaliano(anno: number, mese: number, giorno: number, minuti: number): Date {
  // Si parte come se fosse UTC e si corregge della differenza osservata:
  // due passi bastano anche a cavallo del cambio d'ora.
  let t = Date.UTC(anno, mese - 1, giorno, Math.floor(minuti / 60), minuti % 60)
  for (let i = 0; i < 2; i++) {
    const l = locale(new Date(t))
    const desiderato = Date.UTC(anno, mese - 1, giorno, Math.floor(minuti / 60), minuti % 60)
    const visto = Date.UTC(l.anno, l.mese - 1, l.giorno, Math.floor(l.minutiDelGiorno / 60), l.minutiDelGiorno % 60)
    t += desiderato - visto
  }
  return new Date(t)
}

const minuti = (hhmm: string) => {
  const [h, m] = hhmm.split(':').map(Number)
  return (h ?? 0) * 60 + (m ?? 0)
}

/** True se a quest'ora si può far partire una chiamata. */
export function dentroFascia(d: Date, r: RegoleRichiamata = REGOLE_PREDEFINITE): boolean {
  const m = locale(d).minutiDelGiorno
  return m >= minuti(r.ora_inizio) && m <= minuti(r.ora_fine) - r.margine_fine_minuti
}

/**
 * Quando fare il primo tentativo: subito se si è nella fascia, altrimenti
 * all'apertura della fascia (oggi se è presto, domani se è tardi). Un
 * operatore che lavora la sera fa partire la richiamata, il cliente viene
 * chiamato la mattina dopo alle 8.
 */
export function primoTentativo(ora: Date, r: RegoleRichiamata = REGOLE_PREDEFINITE): Date {
  if (dentroFascia(ora, r)) return ora
  const l = locale(ora)
  const inizio = istanteItaliano(l.anno, l.mese, l.giorno, minuti(r.ora_inizio))
  if (ora < inizio) return inizio
  const domani = new Date(Date.UTC(l.anno, l.mese - 1, l.giorno) + 36 * 3_600_000)
  const ld = locale(domani)
  return istanteItaliano(ld.anno, ld.mese, ld.giorno, minuti(r.ora_inizio))
}

/**
 * Il tentativo successivo dopo una mancata risposta: fra `attesa_min` e
 * `attesa_max` minuti, purché lo stesso giorno e dentro la fascia. null =
 * per oggi basta: la richiamata è "non raggiunto" e torna all'operatore.
 * `caso` (0..1) è passato da fuori per poter provare la funzione.
 */
export function prossimoTentativo(
  ora: Date,
  tentativiFatti: number,
  r: RegoleRichiamata = REGOLE_PREDEFINITE,
  caso: number = Math.random(),
): Date | null {
  if (tentativiFatti >= r.max_tentativi) return null
  const attesa = r.attesa_min_minuti + Math.round((r.attesa_max_minuti - r.attesa_min_minuti) * caso)
  const quando = new Date(ora.getTime() + attesa * 60_000)
  const oggi = locale(ora)
  const allora = locale(quando)
  const stessoGiorno = oggi.anno === allora.anno && oggi.mese === allora.mese && oggi.giorno === allora.giorno
  return stessoGiorno && dentroFascia(quando, r) ? quando : null
}

/**
 * Il numero in formato internazionale (+39…), come lo vuole il trunk SIP.
 * Accetta spazi, punti, trattini, il prefisso 0039; un numero senza
 * prefisso internazionale si considera italiano (cellulari 3…, fissi 0…).
 * null se non sembra un numero di telefono: meglio un errore all'operatore
 * che una chiamata a un numero sbagliato.
 */
export function normalizzaNumero(input: string | null | undefined): string | null {
  if (!input) return null
  let n = input.trim().replace(/[\s.\-/()]/g, '')
  if (n.startsWith('00')) n = '+' + n.slice(2)
  if (!n.startsWith('+')) {
    if (/^3\d{8,9}$/.test(n) || /^0\d{5,10}$/.test(n)) n = '+39' + n
    else return null
  }
  return /^\+\d{8,15}$/.test(n) ? n : null
}

/** Esito di un tentativo, dalla fine della chiamata. */
export type EsitoTentativo = 'risposto' | 'no-answer' | 'busy' | 'segreteria' | 'non_raggiunto' | 'errore'

export function tentativoRiuscito(e: EsitoTentativo): boolean {
  return e === 'risposto'
}
