/**
 * Controllo dei contenuti prima dell'invio.
 *
 * Vive qui e solo qui: l'interfaccia e una futura bozza AI possono
 * proporre qualunque testo, ma solo questa funzione decide se parte
 * davvero. Le regole sono per genere di canale (kind), non per singolo
 * account: un secondo operatore Mirakl eredita le stesse regole senza
 * bisogno di configurarle.
 */

export interface Violazione {
  codice: string
  messaggio: string
  /** La porzione di testo incriminata, così l'agente sa cosa togliere. */
  porzione: string
  /**
   * true = impedisce l'invio (422). false = solo un avviso: il messaggio
   * parte comunque, l'agente decide con gli occhi aperti. Il telefono è
   * l'unico caso oggi: Amazon non lo blocca davvero lato suo (verificato
   * da Domenico su un invio reale), è una policy nostra più prudente
   * della piattaforma — prudente ma non al punto da impedire un caso
   * legittimo come "chiami il centro assistenza per la sostituzione".
   */
  bloccante: boolean
}

export interface EsitoPolicy {
  /** false solo se c'è almeno una violazione bloccante. */
  ok: boolean
  violazioni: Violazione[]
}

const URL_RE = /\bhttps?:\/\/[^\s]+/gi
const EMAIL_RE = /\b[\w.+-]+@[\w-]+\.[\w.-]+\b/gi
// Numeri di telefono: almeno 7 cifre, con separatori comuni, per non
// scambiare un numero d'ordine o un codice prodotto per un contatto.
const TELEFONO_RE = /(?:\+?\d[\s.-]?){7,}\d/g

// Un numero d'ordine Amazon ha la stessa forma superficiale (tre cifre -
// sette cifre - sette cifre, es. 405-0668977-2033157) e la regola non
// deve scambiarlo per un telefono: la stessa distinzione già fatta per
// la redazione di IBAN/carte in core/ai/redazione.ts.
const NUMERO_ORDINE_AMAZON_RE = /^\d{3}-\d{7}-\d{7}$/

// Termini che chiedono una recensione o un contatto fuori piattaforma,
// nelle lingue dei marketplace su cui operiamo. Non è un dato specifico
// di questa azienda: è la policy del canale, uguale per chiunque venda
// su Amazon con questo sistema.
const RICHIESTA_RECENSIONE_TERMINI = [
  // italiano
  'lascia una recensione',
  'lasciaci una recensione',
  'lascia un feedback',
  'valutazione a 5 stelle',
  'recensione positiva',
  // inglese
  'leave a review',
  'leave feedback',
  '5-star rating',
  'positive review',
  'product review',
  // tedesco
  'bewertung hinterlassen',
  'positive bewertung',
  // francese
  'laisser un avis',
  'avis positif',
  // spagnolo
  'deja una reseña',
  'reseña positiva',
]

// I link di tracciamento dei corrieri sono un'eccezione nota alla policy
// URL di Amazon: rispondono a "dov'è il mio pacco", non portano il
// cliente fuori piattaforma per altri scopi. Domini dei corrieri più
// comuni in Italia e internazionali — non è un dato specifico di questa
// azienda: vale per chiunque venda su Amazon con questo sistema, a
// prescindere da quale corriere usi per un singolo ordine.
const DOMINI_CORRIERE = [
  'poste.it',
  'bartolini.it',
  'brt.it',
  'gls-italy.com',
  'gls-group.com',
  'sda.it',
  'nexive.it',
  'inpost.it',
  'ups.com',
  'fedex.com',
  'dhl.com',
  'dhl.it',
  'tnt.com',
  'correos.es',
  'chronopost.fr',
  'colissimo.fr',
  'laposte.fr',
  'parcelforce.com',
  'royalmail.com',
  'hermesworld.com',
  'evri.com',
  '17track.net',
  'aftership.com',
]

function dominioDiCorriere(url: string): boolean {
  try {
    const host = new URL(url).hostname.toLowerCase()
    return DOMINI_CORRIERE.some((d) => host === d || host.endsWith(`.${d}`))
  } catch {
    return false
  }
}

// Un link ad Amazon stesso è la stessa eccezione dei corrieri, stessa
// logica: la regola vieta di portare il cliente FUORI da Amazon, non di
// linkare pagine di Amazon (es. una pagina di aiuto sulle politiche di
// reso) — non è un modo di aggirarla. Domini principali per paese, non
// specifici di questa azienda: valgono per chiunque venda su Amazon con
// questo sistema.
const DOMINI_AMAZON = [
  'amazon.it',
  'amazon.com',
  'amazon.de',
  'amazon.fr',
  'amazon.es',
  'amazon.co.uk',
  'amazon.nl',
  'amazon.se',
  'amazon.pl',
  'amazon.com.be',
]

function dominioAmazon(url: string): boolean {
  try {
    const host = new URL(url).hostname.toLowerCase()
    return DOMINI_AMAZON.some((d) => host === d || host.endsWith(`.${d}`))
  } catch {
    return false
  }
}

const CONTATTA_FUORI_TERMINI = [
  'scrivici direttamente a',
  'contattaci fuori da',
  'contact us directly at',
  'contact us outside',
  'whatsapp',
  'telegram',
]

interface RegoleCanale {
  vieta_url: boolean
  vieta_contatti: boolean
  vieta_richiesta_recensione: boolean
  vieta_contatto_esterno: boolean
  lunghezza_massima: number | null
}

const REGOLE_DEFAULT: RegoleCanale = {
  vieta_url: false,
  vieta_contatti: false,
  vieta_richiesta_recensione: false,
  vieta_contatto_esterno: false,
  lunghezza_massima: null,
}

// Regole dichiarative per genere di canale. Kind è l'enum fisso dello
// schema (shopify|amazon|mirakl|tiktok|email): cambiarle qui non tocca
// nessun dato specifico di un singolo operatore o account.
const REGOLE: Partial<Record<string, RegoleCanale>> = {
  amazon: {
    vieta_url: true,
    vieta_contatti: true,
    vieta_richiesta_recensione: true,
    vieta_contatto_esterno: true,
    lunghezza_massima: 4000,
  },
  mirakl: {
    vieta_url: false,
    vieta_contatti: true,
    vieta_richiesta_recensione: false,
    vieta_contatto_esterno: false,
    lunghezza_massima: null,
  },
  // shopify, email, tiktok: nessuna restrizione — usano REGOLE_DEFAULT.
}

function trovaTutte(testo: string, re: RegExp): string[] {
  return [...testo.matchAll(re)].map((m) => m[0])
}

function contieneTermine(testoMinuscolo: string, termini: string[]): string | null {
  for (const t of termini) {
    if (testoMinuscolo.includes(t)) return t
  }
  return null
}

export function check(kind: string, testo: string): EsitoPolicy {
  const regole = REGOLE[kind] ?? REGOLE_DEFAULT
  const violazioni: Violazione[] = []
  const minuscolo = testo.toLowerCase()

  if (regole.vieta_url) {
    for (const porzione of trovaTutte(testo, URL_RE)) {
      // Un link di tracciamento risponde a "dov'è il mio pacco", un
      // link ad Amazon stessa non porta il cliente fuori piattaforma:
      // due eccezioni note, non un modo di aggirare la regola.
      if (dominioDiCorriere(porzione) || dominioAmazon(porzione)) continue
      violazioni.push({
        codice: 'url_non_ammesso',
        messaggio: 'Il messaggio contiene un link: non ammesso su questo canale.',
        porzione,
        bloccante: true,
      })
    }
  }

  if (regole.vieta_contatti) {
    for (const porzione of trovaTutte(testo, EMAIL_RE)) {
      violazioni.push({
        codice: 'email_non_ammessa',
        messaggio: "Il messaggio contiene un indirizzo email: non ammesso su questo canale.",
        porzione,
        bloccante: true,
      })
    }
    for (const porzione of trovaTutte(testo, TELEFONO_RE)) {
      if (NUMERO_ORDINE_AMAZON_RE.test(porzione)) continue
      violazioni.push({
        codice: 'telefono_non_ammesso',
        messaggio: 'Il messaggio contiene un numero di telefono: non è tecnicamente bloccato dal canale, ma valuta se serve davvero.',
        porzione,
        bloccante: false,
      })
    }
  }

  if (regole.vieta_richiesta_recensione) {
    const trovato = contieneTermine(minuscolo, RICHIESTA_RECENSIONE_TERMINI)
    if (trovato) {
      violazioni.push({
        codice: 'richiesta_recensione',
        messaggio: 'Il messaggio sembra chiedere una recensione o un feedback: non ammesso su questo canale.',
        porzione: trovato,
        bloccante: true,
      })
    }
  }

  if (regole.vieta_contatto_esterno) {
    const trovato = contieneTermine(minuscolo, CONTATTA_FUORI_TERMINI)
    if (trovato) {
      violazioni.push({
        codice: 'contatto_esterno',
        messaggio: 'Il messaggio invita a contattare fuori dalla piattaforma: non ammesso su questo canale.',
        porzione: trovato,
        bloccante: true,
      })
    }
  }

  if (regole.lunghezza_massima !== null && testo.length > regole.lunghezza_massima) {
    violazioni.push({
      codice: 'lunghezza_eccessiva',
      messaggio: `Il messaggio supera i ${regole.lunghezza_massima} caratteri ammessi su questo canale.`,
      porzione: testo.slice(regole.lunghezza_massima, regole.lunghezza_massima + 40) + '…',
      bloccante: true,
    })
  }

  return { ok: !violazioni.some((v) => v.bloccante), violazioni }
}
