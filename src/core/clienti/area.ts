/**
 * Ticket nell'area cliente dei siti (la parte pura).
 *
 * Il cliente vede solo ciò che è passato fra lui e noi: i suoi messaggi e
 * le nostre risposte. Mai note interne, mai notifiche di sistema, mai i
 * ticket collegati verso corriere o assistenza. Gli stati interni diventano
 * poche frasi comprensibili.
 */

export type StatoCliente = 'ricevuto' | 'in_lavorazione' | 'attende_risposta' | 'chiuso'

export const ETICHETTA_STATO: Record<StatoCliente, string> = {
  ricevuto: 'Ricevuto',
  in_lavorazione: 'In lavorazione',
  attende_risposta: 'In attesa di una tua risposta',
  chiuso: 'Chiuso',
}

export function statoPerCliente(stato: string): StatoCliente {
  switch (stato) {
    case 'new':
    case 'unmatched':
      return 'ricevuto'
    case 'pending_customer':
      return 'attende_risposta'
    case 'closed':
      return 'chiuso'
    default:
      return 'in_lavorazione'
  }
}

export function normalizzaEmail(e: string): string {
  return e.trim().toLowerCase()
}

/**
 * Le righe di servizio che l'assistente vocale aggiunge in fondo al
 * riepilogo della telefonata ("Cliente verificato sull'ordine.", il numero
 * da cui ha chiamato) servono all'operatore, non al cliente.
 */
const RIGHE_DI_SERVIZIO = [
  /^Cliente (NON )?verificato/i,
  /^Numero da cui ha chiamato:/i,
  /^Contatto per la risposta:/i,
]

export function testoPerCliente(testo: string, canale: string, autore: string): string {
  if (canale !== 'telefono' || autore !== 'customer') return testo
  return testo
    .split('\n')
    .filter((r) => !RIGHE_DI_SERVIZIO.some((re) => re.test(r.trim())))
    .join('\n')
    .trim()
}

/**
 * Lo stato della pratica come lo legge il cliente nella sua area (chiesto da
 * Domenico il 2026-11-26). Parole semplici, niente esiti interni: la "non
 * conformità" del magazzino per il cliente è una verifica in corso.
 */
export const ETICHETTA_PRATICA: Record<string, string> = {
  ricevuta: 'Richiesta ricevuta',
  etichetta_inviata: 'Etichetta di reso inviata',
  rientrata: 'Prodotto arrivato al nostro magazzino',
  rientrata_sostituzione: 'Prodotto arrivato: lo sostituiamo',
  rientrata_sostituzione_altro_modello: 'Prodotto arrivato: lo sostituiamo con un altro modello',
  rientrata_riparazione: 'Prodotto arrivato: in riparazione',
  rientrata_funzionante: 'Prodotto arrivato: verificato funzionante',
  rientrata_non_conforme: 'Prodotto arrivato: in verifica',
  spedita: 'Prodotto spedito',
  chiusa: 'Pratica chiusa',
}

export function praticaPerCliente(stato: string | null | undefined): string | null {
  return stato ? (ETICHETTA_PRATICA[stato] ?? null) : null
}
