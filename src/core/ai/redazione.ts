/**
 * Oscuramento dei dati personali prima che qualunque testo entri in un
 * prompt — regola 8 di CLAUDE.md, non negoziabile: IBAN, numeri di carta
 * e codici fiscali non finiscono mai nel contesto di un modello.
 *
 * Vive qui e si applica SEMPRE, prima di costruire il prompt: non è il
 * modello a doversi ricordare di ignorarli, è il codice a non
 * consegnarglieli mai.
 */

// IBAN: due lettere (paese) + due cifre di controllo + fino a 30
// alfanumerici, con o senza spazi fra i gruppi di quattro.
const IBAN_RE = /\b[A-Z]{2}\d{2}[ ]?(?:[A-Z0-9]{4}[ ]?){2,7}[A-Z0-9]{1,4}\b/g

// Carte di pagamento: o quattro gruppi da quattro cifre (il formato con
// cui si scrivono davvero, spaziato o con trattini), o una sequenza di
// 13-19 cifre tutte insieme. NON un pattern generico "cifre con
// trattini qua e là": un numero d'ordine Amazon ha la stessa forma
// superficiale (tre cifre - sette cifre - sette cifre, es.
// 407-6403985-4699551) e non deve sparire dal contesto.
const CARTA_RE = /\b\d{4}[ -]\d{4}[ -]\d{4}[ -]\d{1,4}\b|\b\d{13,19}\b/g

// Codice fiscale italiano: 6 lettere, 2 cifre, 1 lettera, 2 cifre,
// 1 lettera, 3 cifre, 1 lettera — forma fissa, difficile da confondere
// con altro.
const CODICE_FISCALE_RE = /\b[A-Z]{6}\d{2}[A-EHLMPR-T]\d{2}[A-Z]\d{3}[A-Z]\b/gi

export interface EsitoRedazione {
  testo: string
  /** Quanti dati sono stati oscurati, per genere. Utile per un log o un test. */
  trovati: { iban: number; carta: number; codice_fiscale: number }
}

export function redigi(testo: string): EsitoRedazione {
  let trovati = { iban: 0, carta: 0, codice_fiscale: 0 }

  let risultato = testo.replace(CODICE_FISCALE_RE, () => {
    trovati.codice_fiscale += 1
    return '[codice fiscale oscurato]'
  })
  risultato = risultato.replace(IBAN_RE, () => {
    trovati.iban += 1
    return '[IBAN oscurato]'
  })
  risultato = risultato.replace(CARTA_RE, () => {
    trovati.carta += 1
    return '[numero di carta oscurato]'
  })

  return { testo: risultato, trovati }
}

/**
 * Oscuramento **reversibile**, per i testi che dopo il modello vanno al
 * cliente: le nostre risposte da tradurre.
 *
 * `redigi()` basta per ciò che l'operatore deve solo leggere (la
 * traduzione di un messaggio in arrivo: l'originale resta comunque
 * visibile). Non basta per un testo da spedire: se l'operatore scrive
 * un dato personale che il cliente deve ricevere, il modello non deve
 * vederlo (regola 8) ma il testo tradotto non può arrivare al cliente
 * con "[IBAN oscurato]" al suo posto.
 *
 * Quindi ogni dato diventa un segnaposto numerato (`⟦1⟧`), il modello
 * ha l'istruzione di lasciarlo intatto, e `ripristina()` rimette il
 * valore vero. Se un segnaposto manca o compare due volte, `ripristina()`
 * **lancia invece di indovinare**: meglio una traduzione da rifare che
 * una risposta partita senza il dato che serviva, o con il dato giusto
 * nel punto sbagliato.
 */
export interface TestoProtetto {
  testo: string
  segnaposti: number
  ripristina(tradotto: string): string
}

export function proteggi(testo: string): TestoProtetto {
  const valori: string[] = []
  const sostituisci = (corrispondenza: string): string => {
    valori.push(corrispondenza)
    return `⟦${valori.length}⟧`
  }

  // Stesso ordine di redigi(): il codice fiscale prima, perché le sue
  // cifre non vengano mangiate dal pattern delle carte.
  const protetto = testo
    .replace(CODICE_FISCALE_RE, sostituisci)
    .replace(IBAN_RE, sostituisci)
    .replace(CARTA_RE, sostituisci)

  return {
    testo: protetto,
    segnaposti: valori.length,
    ripristina(tradotto: string): string {
      let risultato = tradotto
      for (let i = 0; i < valori.length; i += 1) {
        const segnaposto = `⟦${i + 1}⟧`
        const occorrenze = risultato.split(segnaposto).length - 1
        if (occorrenze !== 1) {
          throw new Error(
            `La traduzione ha ${occorrenze === 0 ? 'perso' : 'duplicato'} un dato da ` +
              'conservare (IBAN, carta o codice fiscale): riprova a tradurre.',
          )
        }
        risultato = risultato.replace(segnaposto, valori[i]!)
      }
      return risultato
    },
  }
}
