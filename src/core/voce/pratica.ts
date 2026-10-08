/**
 * "A che punto è la mia pratica?" al telefono: la parte pura.
 *
 * È la domanda più frequente nelle 1.779 conversazioni Zendesk del partner
 * garanzie (report del 08/10) e la prima causa dei giudizi negativi. La
 * maggior parte di quei clienti ha comprato in negozio: non ha un ordine,
 * ha un numero di pratica. Qui si decide cosa dire, non come trovarla.
 */

export type FasePratica =
  | 'chiusa'
  | 'attende_cliente'
  | 'attende_registrazione_garanzia'
  | 'prodotto_rientrato'
  | 'garanzia_registrata'
  | 'ricevuta'
  | 'in_lavorazione'

export function fasePratica(stato: string, tags: readonly string[]): FasePratica {
  if (stato === 'closed') return 'chiusa'
  if (tags.includes('attesa-registrazione-garanzia')) return 'attende_registrazione_garanzia'
  if (stato === 'pending_customer') return 'attende_cliente'
  if (tags.includes('pacco-rientrato-logistica')) return 'prodotto_rientrato'
  if (tags.includes('garanzia-registrata')) return 'garanzia_registrata'
  if (stato === 'new' || stato === 'unmatched') return 'ricevuta'
  return 'in_lavorazione'
}

/** Giorni lavorativi (lun-ven) trascorsi fra due istanti, ora italiana non necessaria: conta i giorni pieni. */
export function giorniLavorativiTra(da: Date, a: Date): number {
  if (a <= da) return 0
  let n = 0
  const d = new Date(Date.UTC(da.getUTCFullYear(), da.getUTCMonth(), da.getUTCDate()))
  const fine = new Date(Date.UTC(a.getUTCFullYear(), a.getUTCMonth(), a.getUTCDate()))
  while (d < fine) {
    d.setUTCDate(d.getUTCDate() + 1)
    const g = d.getUTCDay()
    if (g !== 0 && g !== 6) n++
  }
  return n
}

/**
 * Oltre questa soglia una pratica "in lavorazione" è ferma: il report la
 * indica come il caso in cui deve intervenire un operatore. È anche il
 * tempo che il partner promette per l'analisi ("fino a 10 giorni
 * lavorativi").
 */
export const GIORNI_PRATICA_FERMA = 10

export function praticaFerma(fase: FasePratica, ultimoMovimento: Date, ora: Date = new Date()): boolean {
  if (fase === 'chiusa' || fase === 'attende_cliente' || fase === 'attende_registrazione_garanzia') return false
  return giorniLavorativiTra(ultimoMovimento, ora) > GIORNI_PRATICA_FERMA
}

/** Dal terzo contatto del cliente sulla stessa pratica decide un operatore (report, sezione F). */
export const CONTATTI_PER_OPERATORE = 3

/** Il numero di pratica dettato: "dodicimila centodiciannove", "1 2 1 1 9", "#12119" → 12119. */
export function numeroPratica(v: string): number | null {
  const cifre = v.replace(/\D/g, '')
  if (cifre.length < 3 || cifre.length > 9) return null
  return Number(cifre)
}
