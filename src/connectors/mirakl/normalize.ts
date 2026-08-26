/**
 * Da risposta M11 a modello canonico.
 *
 * ATTENZIONE — questo modulo è scritto sulla DOCUMENTAZIONE, non su una
 * risposta reale: al momento in cui l'abbiamo costruito nessun cliente
 * Mirakl aveva ancora scritto, quindi `/api/inbox/threads` restituiva
 * `{"data":[]}`.
 *
 * Per questo il normalizzatore è deliberatamente tollerante e loquace:
 * non dà per scontato nessun campo, e quando trova qualcosa che non si
 * aspetta lo REGISTRA invece di ignorarlo o di rompersi. Il primo
 * messaggio vero ci dirà cosa correggere, e lo dirà in chiaro dentro
 * `ingest_anomaly` invece che con un errore a caso tre giorni dopo.
 *
 * Campi presi dallo schema M11: data / next_page_token; thread con id,
 * topic, date_created, date_updated, entities, messages; entity con
 * type, id, label; message con id, body, date_created, from, to,
 * attachments.
 */

export interface AllegatoMirakl {
  external_id: string | null
  nome_file: string | null
  dimensione_byte: number | null
}

export interface MessaggioMirakl {
  external_id: string | null
  direzione: 'in' | 'out'
  autore: string | null
  /** Il valore grezzo di from.type: serve per capire i casi non previsti. */
  tipo_mittente: string | null
  corpo: string | null
  inviato_il: string | null
  allegati: AllegatoMirakl[]
  raw: unknown
}

export interface ThreadMirakl {
  external_thread_id: string
  oggetto: string | null
  creato_il: string | null
  aggiornato_il: string | null
  /** Identificativo dell'ordine Mirakl, quando il thread è legato a uno. */
  external_order_id: string | null
  messaggi: MessaggioMirakl[]
  raw: unknown
}

export interface EsitoNormalizza {
  threads: ThreadMirakl[]
  /** Cose che non tornano: finiscono in ingest_anomaly, non nel vuoto. */
  stranezze: Array<{ tipo: string; dettaglio: unknown }>
}

/**
 * Quali valori di `from.type` significano "l'abbiamo scritto noi".
 * Configurabile perché è l'unica cosa che non ho potuto verificare: se
 * l'enum reale è diverso, si corregge senza toccare il codice.
 */
export const MITTENTI_NOSTRI_PREDEFINITI = ['SHOP', 'SELLER', 'STORE']

/** L'entità che rappresenta un ordine nel modello Mirakl. */
const ENTITA_ORDINE = ['MMP_ORDER', 'MPS_ORDER']

function testo(v: unknown): string | null {
  return typeof v === 'string' && v.trim() !== '' ? v : null
}

function numero(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null
}

export function normalizzaRisposta(
  risposta: unknown,
  mittentiNostri: string[] = MITTENTI_NOSTRI_PREDEFINITI,
): EsitoNormalizza {
  const stranezze: EsitoNormalizza['stranezze'] = []
  const threads: ThreadMirakl[] = []

  const dati = (risposta as { data?: unknown })?.data
  if (!Array.isArray(dati)) {
    stranezze.push({
      tipo: 'mirakl_risposta_senza_data',
      dettaglio: { chiavi: chiaviDi(risposta) },
    })
    return { threads, stranezze }
  }

  for (const grezzo of dati) {
    const t = grezzo as Record<string, unknown>
    const id = testo(t?.id)

    if (!id) {
      // Senza identificativo non possiamo essere idempotenti: meglio
      // saltarlo e dirlo, che inserirlo e duplicarlo a ogni giro.
      stranezze.push({
        tipo: 'mirakl_thread_senza_id',
        dettaglio: { chiavi: chiaviDi(t) },
      })
      continue
    }

    threads.push({
      external_thread_id: id,
      oggetto: oggettoDi(t.topic),
      creato_il: testo(t.date_created),
      aggiornato_il: testo(t.date_updated),
      external_order_id: ordineDa(t.entities, stranezze, id),
      messaggi: messaggiDa(t.messages, mittentiNostri, stranezze, id),
      raw: grezzo,
    })
  }

  return { threads, stranezze }
}

/**
 * Il topic può essere testo libero oppure un codice motivo: la
 * documentazione dice entrambi. Accettiamo le due forme.
 */
function oggettoDi(topic: unknown): string | null {
  if (typeof topic === 'string') return testo(topic)
  const t = topic as Record<string, unknown> | null
  return (
    testo(t?.value) ?? testo(t?.label) ?? testo(t?.reason_label) ?? testo(t?.code)
  )
}

function ordineDa(
  entities: unknown,
  stranezze: EsitoNormalizza['stranezze'],
  threadId: string,
): string | null {
  if (!Array.isArray(entities)) return null
  for (const e of entities) {
    const ent = e as Record<string, unknown>
    const tipo = testo(ent?.type)
    const id = testo(ent?.id)
    if (!tipo || !id) continue
    if (ENTITA_ORDINE.includes(tipo)) return id
  }
  // Un thread senza ordine è legittimo (comunicazioni con l'operatore),
  // quindi non è una stranezza — ma se il tipo è ignoto vale la pena
  // saperlo, perché potrebbe essere un ordine chiamato in un altro modo.
  const tipiVisti = entities
    .map((e) => testo((e as Record<string, unknown>)?.type))
    .filter((x): x is string => x !== null)
  if (tipiVisti.length > 0 && !tipiVisti.some((t) => ENTITA_ORDINE.includes(t))) {
    stranezze.push({
      tipo: 'mirakl_entita_non_riconosciuta',
      dettaglio: { thread: threadId, tipi: tipiVisti },
    })
  }
  return null
}

function messaggiDa(
  messages: unknown,
  mittentiNostri: string[],
  stranezze: EsitoNormalizza['stranezze'],
  threadId: string,
): MessaggioMirakl[] {
  if (!Array.isArray(messages)) return []
  const fuori: MessaggioMirakl[] = []

  for (const m of messages) {
    const msg = m as Record<string, unknown>
    const from = msg?.from as Record<string, unknown> | undefined
    const tipoMittente = testo(from?.type)

    // Il verso del messaggio è l'unica cosa che non ho potuto
    // verificare su dati veri. Se il tipo è ignoto lo registriamo: è
    // l'informazione che serve per correggere l'elenco.
    if (tipoMittente && !mittentiNostri.includes(tipoMittente)) {
      const gia = stranezze.some(
        (s) =>
          s.tipo === 'mirakl_tipo_mittente' &&
          (s.dettaglio as { tipo?: string })?.tipo === tipoMittente,
      )
      if (!gia) {
        stranezze.push({
          tipo: 'mirakl_tipo_mittente',
          dettaglio: { thread: threadId, tipo: tipoMittente },
        })
      }
    }

    fuori.push({
      external_id: testo(msg?.id),
      direzione: tipoMittente && mittentiNostri.includes(tipoMittente) ? 'out' : 'in',
      autore: testo(from?.display_name),
      tipo_mittente: tipoMittente,
      corpo: testo(msg?.body),
      inviato_il: testo(msg?.date_created),
      allegati: allegatiDa(msg?.attachments),
      raw: m,
    })
  }

  return fuori
}

function allegatiDa(attachments: unknown): AllegatoMirakl[] {
  if (!Array.isArray(attachments)) return []
  return attachments.map((a) => {
    const att = a as Record<string, unknown>
    return {
      external_id: testo(att?.id),
      nome_file: testo(att?.name),
      dimensione_byte: numero(att?.size),
    }
  })
}

/** Le chiavi di primo livello: quanto basta a capire cosa è arrivato. */
function chiaviDi(v: unknown): string[] {
  if (v === null || typeof v !== 'object') return []
  return Object.keys(v as Record<string, unknown>)
}
