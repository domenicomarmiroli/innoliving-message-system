import { redigi } from '../ai/redazione.js'

/**
 * Oscuramento della richiesta di uno strumento vocale prima che finisca
 * in `voice_log`. Regola 8: il registro serve a capire cosa ha chiesto
 * l'agente e com'è andata, non a conservare email, telefoni e indirizzi
 * dei clienti.
 *
 * Due livelli. Per i campi che sappiamo cosa contengono (dal nome) si
 * lascia una traccia utile a chi indaga — il dominio dell'email, le
 * ultime cifre del telefono, le prime due del CAP — senza il dato
 * intero. Per tutto il resto, testo libero compreso (la descrizione del
 * problema detta dal cliente), si cercano email e telefoni dentro il
 * testo e si passa da `redigi()` per IBAN, carte e codici fiscali.
 *
 * Il numero d'ordine NON si oscura: è la chiave per capire una chiamata
 * nel registro, e un numero Amazon (403-1234567-1234567) non deve essere
 * scambiato per un telefono.
 */

type Regola = (valore: string) => string

const EMAIL_RE = /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi

// Telefoni dentro un testo: con prefisso internazionale, cellulari
// italiani (3xx) e fissi (0x). I lookaround escludono le cifre attaccate
// a un trattino seguito da altre cifre: è la forma dei numeri d'ordine
// Amazon, che non sono telefoni.
const TELEFONO_RE =
  /(?<![\d-])(?:(?:\+|00)\d{1,3}[\s.-]?)?(?:3\d{2}|0\d{1,3})(?:[\s.-]?\d){5,8}(?![\d-]?\d)/g

const MASSIMA_LUNGHEZZA = 1000
const MASSIMA_PROFONDITA = 6

export function mascheraEmail(v: string): string {
  const at = v.lastIndexOf('@')
  if (at <= 0) return '[email oscurata]'
  return `${v[0]}***${v.slice(at)}`
}

export function mascheraTelefono(v: string): string {
  const cifre = v.replace(/\D/g, '')
  if (cifre.length < 6) return '[telefono oscurato]'
  return `***${cifre.slice(-3)}`
}

const mascheraContatto: Regola = (v) => (v.includes('@') ? mascheraEmail(v) : mascheraTelefono(v))
const mascheraCap: Regola = (v) => {
  const t = v.trim()
  return t.length <= 2 ? '***' : `${t.slice(0, 2)}***`
}
const mascheraNome: Regola = (v) => {
  const t = v.trim()
  return t ? `${t[0]!.toUpperCase()}.` : ''
}
const oscuraTutto: Regola = () => '[oscurato]'
const oscuraIndirizzo: Regola = () => '[indirizzo oscurato]'

const PER_CHIAVE: Record<string, Regola> = {
  email: mascheraEmail,
  e_mail: mascheraEmail,
  mail: mascheraEmail,
  telefono: mascheraTelefono,
  phone: mascheraTelefono,
  caller_number: mascheraTelefono,
  numero_chiamante: mascheraTelefono,
  to_number: mascheraTelefono,
  from_number: mascheraTelefono,
  contatto_richiamata: mascheraContatto,
  contatto: mascheraContatto,
  postal_code: mascheraCap,
  cap: mascheraCap,
  zip: mascheraCap,
  nome: mascheraNome,
  cognome: mascheraNome,
  name: mascheraNome,
  first_name: mascheraNome,
  last_name: mascheraNome,
  indirizzo: oscuraIndirizzo,
  address: oscuraIndirizzo,
  address1: oscuraIndirizzo,
  address2: oscuraIndirizzo,
  via: oscuraIndirizzo,
  street: oscuraIndirizzo,
  session_token: oscuraTutto,
  token: oscuraTutto,
  secret: oscuraTutto,
}

/** Email e telefoni dentro un testo libero, più IBAN/carte/codici fiscali. */
export function oscuraTesto(testo: string): string {
  const ridotto =
    testo.length > MASSIMA_LUNGHEZZA ? `${testo.slice(0, MASSIMA_LUNGHEZZA)}…[troncato]` : testo
  return redigi(ridotto)
    .testo.replace(EMAIL_RE, (e) => mascheraEmail(e))
    .replace(TELEFONO_RE, (t) => mascheraTelefono(t))
}

export function sanificaPerRegistro(valore: unknown, profondita = 0): unknown {
  if (valore === null || valore === undefined) return valore ?? null
  if (profondita > MASSIMA_PROFONDITA) return '[troppo annidato]'
  if (typeof valore === 'string') return oscuraTesto(valore)
  if (typeof valore === 'number' || typeof valore === 'boolean') return valore
  if (Array.isArray(valore)) return valore.map((v) => sanificaPerRegistro(v, profondita + 1))
  if (typeof valore === 'object') {
    const risultato: Record<string, unknown> = {}
    for (const [chiave, v] of Object.entries(valore as Record<string, unknown>)) {
      const regola = PER_CHIAVE[chiave.toLowerCase()]
      if (regola && v !== null && v !== undefined) {
        risultato[chiave] = regola(String(v))
      } else {
        risultato[chiave] = sanificaPerRegistro(v, profondita + 1)
      }
    }
    return risultato
  }
  return null
}
