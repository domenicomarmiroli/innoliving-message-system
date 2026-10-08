/**
 * Verifica di chi chiama: la parte pura, senza database.
 *
 * Al telefono il numero d'ordine arriva dettato e trascritto: con spazi,
 * senza trattini, con o senza il prefisso del negozio, con il cancelletto
 * o la parola "numero" davanti. Per questo il confronto non si fa sul
 * testo com'è, ma su una forma ridotta — solo lettere maiuscole e cifre —
 * applicata allo stesso modo all'input e agli identificativi in archivio.
 * Un numero Amazon dettato "407 6086160 1682752" e salvato come
 * "407-6086160-1682752" diventano la stessa stringa.
 */

export const MASSIMO_TENTATIVI = 3
export const DURATA_SESSIONE_MINUTI = 30

export type MotivoRifiuto =
  | 'ordine_non_trovato'
  | 'dati_non_corrispondenti'
  | 'dati_non_disponibili'
  | 'troppi_tentativi'

/** Solo lettere maiuscole e cifre: la forma su cui si confrontano i numeri d'ordine. */
export function riduciRiferimento(v: string): string {
  return v
    .normalize('NFKD')
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, '')
}

/**
 * Il cliente può dettare solo le cifre di un numero che in archivio ha un
 * prefisso di lettere ("9065" per un ordine del sito con prefisso del
 * negozio). In quel caso si accettano i nomi fatti da sole lettere
 * seguite esattamente da quelle cifre. Il prefisso non è scritto nel
 * codice: è qualunque sequenza di lettere.
 */
export function soloCifre(ridotto: string): boolean {
  return /^\d+$/.test(ridotto)
}

export function riduciCap(v: string): string {
  return v.toUpperCase().replace(/[^A-Z0-9]/g, '')
}

export function riduciEmail(v: string): string {
  return v.trim().toLowerCase()
}

export interface OrdineDaVerificare {
  id: string
  email: string | null
  cap: string | null
}

export interface Credenziali {
  email?: string | null | undefined
  cap?: string | null | undefined
}

export type EsitoConfronto =
  | { ok: true; ordine: OrdineDaVerificare }
  | { ok: false; motivo: Exclude<MotivoRifiuto, 'troppi_tentativi'> }

/**
 * Basta un dato che corrisponde: email OPPURE CAP di spedizione. Se più
 * ordini hanno lo stesso numero ridotto (caso raro, ma i formati dei
 * canali sono diversi), vince solo quello per cui i dati corrispondono;
 * se ne corrispondono due, non si sceglie a caso.
 */
export function confrontaCredenziali(ordini: OrdineDaVerificare[], c: Credenziali): EsitoConfronto {
  if (ordini.length === 0) return { ok: false, motivo: 'ordine_non_trovato' }

  const email = c.email ? riduciEmail(c.email) : null
  const cap = c.cap ? riduciCap(c.cap) : null

  const corrispondenti = ordini.filter(
    (o) =>
      (email !== null && email !== '' && o.email !== null && riduciEmail(o.email) === email) ||
      (cap !== null && cap !== '' && o.cap !== null && riduciCap(o.cap) === cap),
  )
  if (corrispondenti.length === 1) return { ok: true, ordine: corrispondenti[0]! }
  if (corrispondenti.length > 1) return { ok: false, motivo: 'dati_non_corrispondenti' }

  // Nessun dato in archivio con cui confrontare: non è colpa di chi chiama,
  // e l'agente deve aprire un ticket invece di chiedere di riprovare.
  const verificabile = ordini.some((o) => o.email !== null || o.cap !== null)
  return { ok: false, motivo: verificabile ? 'dati_non_corrispondenti' : 'dati_non_disponibili' }
}

/**
 * Verifica senza numero d'ordine: fra gli ordini trovati per email (già
 * dal più recente) vale il primo il cui CAP di spedizione corrisponde.
 * Qui due ordini con gli stessi dati non sono un'ambiguità: è lo stesso
 * cliente, e si parla dell'ultimo acquisto.
 */
export function ordineRecenteConCap(ordini: OrdineDaVerificare[], cap: string): EsitoConfronto {
  if (ordini.length === 0) return { ok: false, motivo: 'ordine_non_trovato' }
  const c = riduciCap(cap)
  const trovato = ordini.find((o) => o.cap !== null && riduciCap(o.cap) === c)
  if (trovato) return { ok: true, ordine: trovato }
  return { ok: false, motivo: ordini.some((o) => o.cap !== null) ? 'dati_non_corrispondenti' : 'dati_non_disponibili' }
}

/** Solo il nome di battesimo, per salutare: mai il cognome al telefono. */
export function nomeDiBattesimo(nomeCompleto: string | null | undefined): string | null {
  const primo = nomeCompleto?.trim().split(/\s+/)[0]
  if (!primo) return null
  return primo.charAt(0).toUpperCase() + primo.slice(1).toLowerCase()
}

/** Come dire al telefono dove è stato fatto l'ordine. */
export function etichettaCanale(channel: string, operator: string | null): string {
  switch (channel) {
    case 'amazon':
      return 'Amazon'
    case 'mirakl':
      return operator ?? 'marketplace'
    case 'tiktok':
      return 'TikTok Shop'
    case 'shopify':
      return 'sito'
    default:
      return channel
  }
}

/**
 * Richiamata: chi risponde dice il suo nome, e lo si confronta con gli
 * intestatari dell'ordine (spedizione e fatturazione) o con il nome
 * lasciato nel ticket. Il nome arriva trascritto dal parlato, quindi:
 * niente accenti né maiuscole, parole in qualunque ordine ("Rossi Mario"),
 * un errore di una lettera tollerato su UNA parola lunga (due parole
 * "quasi uguali" farebbero passare Maria Rossa per Mario Rossi).
 *
 * Basta il cognome solo se in archivio c'è solo quello; altrimenti servono
 * almeno due parole in comune: un nome di battesimo da solo ("Maria") non
 * identifica nessuno, e "De Luca" non deve corrispondere a "Luca".
 */
export function paroleNome(v: string): string[] {
  return v
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z\s'-]/g, ' ')
    .split(/[\s'-]+/)
    .filter((p) => p.length >= 2)
}

function quasiUguali(a: string, b: string): boolean {
  if (a === b) return true
  if (Math.min(a.length, b.length) < 5 || Math.abs(a.length - b.length) > 1) return false
  // Distanza di modifica al massimo 1.
  let i = 0
  let j = 0
  let differenze = 0
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) {
      i++
      j++
      continue
    }
    if (++differenze > 1) return false
    if (a.length > b.length) i++
    else if (b.length > a.length) j++
    else {
      i++
      j++
    }
  }
  return differenze + (a.length - i) + (b.length - j) <= 1
}

export function nomeCorrisponde(detto: string, candidati: readonly string[]): boolean {
  const parole = paroleNome(detto)
  if (parole.length === 0) return false
  return candidati.some((c) => {
    const attese = paroleNome(c)
    if (attese.length === 0) return false
    const esatte = attese.filter((a) => parole.includes(a)).length
    const approssimate = attese.filter((a) => !parole.includes(a) && parole.some((p) => quasiUguali(p, a))).length
    return esatte + Math.min(approssimate, 1) >= Math.min(2, attese.length)
  })
}
