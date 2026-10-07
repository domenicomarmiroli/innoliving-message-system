import { createHmac, timingSafeEqual } from 'node:crypto'

/**
 * Garanzia segnalata al telefono → registrazione sul portale garanzie.
 *
 * Il cliente chiama, l'assistente vocale apre il ticket e il cliente riceve
 * un'email con il link al portale del brand. Il link porta con sé la
 * richiesta e una chiave firmata: registrando la garanzia, il portale la
 * collega al ticket già aperto senza che il cliente debba ricopiare numeri,
 * e funziona anche se si registra con un'email diversa da quella detta al
 * telefono. La chiave è un HMAC dell'id del ticket: non si indovina e non
 * apre nient'altro.
 */

export const TAG_ATTESA_REGISTRAZIONE = 'attesa-registrazione-garanzia'
export const TAG_GARANZIA_REGISTRATA = 'garanzia-registrata'

export function chiaveCollegamento(threadId: string, segreto: string): string {
  return createHmac('sha256', segreto).update(`garanzia:${threadId}`).digest('hex').slice(0, 32)
}

export function chiaveValida(threadId: string, chiave: string | null | undefined, segreto: string): boolean {
  if (!chiave) return false
  const atteso = Buffer.from(chiaveCollegamento(threadId, segreto))
  const dato = Buffer.from(chiave)
  return atteso.length === dato.length && timingSafeEqual(atteso, dato)
}

export function linkPortale(base: string, threadId: string, chiave: string): string {
  const url = new URL(base)
  url.searchParams.set('richiesta', threadId)
  url.searchParams.set('chiave', chiave)
  return url.toString()
}

export interface DatiEmailGaranzia {
  numero: string
  nome: string | null
  marchio: string
  prodotto: string | null
  link: string
}

/**
 * L'email al cliente: breve, un'azione sola, niente gergo. Testo semplice
 * (ogni client di posta lo mostra bene, anche sul telefono) con il link
 * su una riga a sé, così si tocca facilmente.
 */
export function emailRegistrazioneGaranzia(d: DatiEmailGaranzia): { oggetto: string; testo: string } {
  const saluto = d.nome ? `Gentile ${d.nome},` : 'Gentile cliente,'
  const cosa = d.prodotto ? ` per il suo ${d.prodotto}` : ''
  return {
    oggetto: `Richiesta n. ${d.numero}: registri il prodotto per la garanzia ${d.marchio}`,
    testo: [
      saluto,
      '',
      `grazie per averci chiamato. Abbiamo aperto la richiesta di assistenza in garanzia n. ${d.numero}${cosa}.`,
      '',
      'Ora ci servono lo scontrino e i dati del prodotto. Bastano due minuti:',
      '',
      `1. Apra questo link: ${d.link}`,
      '2. Confermi la sua email: le mandiamo un codice da inserire nella stessa pagina (nessuna password).',
      '3. Controlli i dati del prodotto e carichi la foto dello scontrino o della fattura.',
      '',
      `Fatto questo, la registrazione si collega da sola alla richiesta n. ${d.numero}: non deve premere altro né riscriverci.`,
      'Il nostro servizio clienti vede subito lo scontrino e la ricontatta.',
      '',
      'Se ha bisogno di aiuto, risponda pure a questa email.',
      '',
      `Il servizio clienti ${d.marchio}`,
    ].join('\n'),
  }
}

export interface DatiRegistrazione {
  prodotto?: string | null
  codice?: string | null
  numero_seriale?: string | null
  data_acquisto?: string | null
  garanzia_fino_al?: string | null
  numero_ordine?: string | null
  rivenditore?: string | null
}

/** Il messaggio che compare nel ticket quando la garanzia è registrata. */
export function testoRegistrazione(d: DatiRegistrazione): string {
  const righe: string[] = ['Prodotto registrato sul portale garanzie.', '']
  const campo = (etichetta: string, v: string | null | undefined) => {
    if (v && v.trim()) righe.push(`${etichetta}: ${v.trim()}`)
  }
  campo('Prodotto', d.prodotto)
  campo('Codice', d.codice)
  campo('Numero di serie', d.numero_seriale)
  campo('Data di acquisto', d.data_acquisto)
  campo('Garanzia valida fino al', d.garanzia_fino_al)
  campo('Numero d’ordine', d.numero_ordine)
  campo('Acquistato presso', d.rivenditore)
  return righe.join('\n').trim()
}
