/**
 * Tipi del connettore casella.
 *
 * Sono deliberatamente indipendenti da IMAP: quando passeremo a
 * Microsoft Graph cambierà chi li produce, non chi li consuma.
 */

/** Una email già estratta dal formato RFC822, prima di ogni giudizio. */
export interface EmailGrezza {
  /** Message-ID dell'intestazione. È la chiave contro i duplicati. */
  rfc822_id: string | null
  in_reply_to: string | null
  /** Catena References, dal più vecchio al più recente. */
  references: string[]
  from: string | null
  reply_to: string | null
  to: string[]
  subject: string | null
  date: Date | null
  body_text: string | null
  body_html: string | null
  allegati: AllegatoGrezzo[]
  /** UID IMAP: serve solo a riprendere da dove eravamo rimasti. */
  uid: number | null
}

export interface AllegatoGrezzo {
  nome_file: string | null
  mime: string | null
  dimensione_byte: number
  /** Checksum del contenuto: identifica l'allegato senza conservarlo. */
  checksum: string
}

/** Le regole di riconoscimento, come stanno nel database. */
export interface RegolaCanale {
  account_id: string
  code: string
  kind: 'shopify' | 'amazon' | 'mirakl' | 'tiktok' | 'email'
  sender_domains: string[]
  order_id_pattern: string | null
}

/** L'esito del riconoscimento: da chi arriva e, se si capisce, per quale ordine. */
export interface Riconoscimento {
  /** Account a cui attribuire il thread. Mai null: c'è sempre la casella. */
  account_id: string
  account_code: string
  kind: RegolaCanale['kind']
  /** Alias del relay, quando il mittente è un relay di marketplace. */
  alias: string | null
  /** Numero d'ordine estratto dal testo, quando il formato lo consente. */
  numero_ordine: string | null
  /** Come ci siamo arrivati: finisce in message.match_strategy. */
  strategia: StrategiaMatch
}

export type StrategiaMatch =
  | 'alias'          // l'alias del mittente corrisponde a order.buyer_alias
  | 'numero_ordine'  // numero d'ordine trovato nel testo
  | 'thread'         // In-Reply-To/References puntano a un messaggio già nostro
  | 'nessuna'        // non agganciato: il thread resta unmatched

/** Il messaggio pronto per il database. */
export interface MessaggioCanonico {
  grezzo: EmailGrezza
  riconoscimento: Riconoscimento
  order_id: string | null
  external_thread_id: string | null
}
