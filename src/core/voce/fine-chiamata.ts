import { createHmac, timingSafeEqual } from 'node:crypto'

/**
 * Webhook di fine chiamata di ElevenLabs (fase 5): la parte pura.
 *
 * Firma verificata sul codice dell'SDK ufficiale (`wrapper/webhooks.js`,
 * 06/10), perché la documentazione non la descrive: header
 * `ElevenLabs-Signature: t=<unix secondi>,v0=<hex>`, dove l'hex è
 * HMAC-SHA256 con il secret del webhook di `"<t>.<corpo grezzo>"`.
 * Tolleranza dell'SDK: 30 minuti.
 */

const TOLLERANZA_MS = 30 * 60_000

export function verificaFirmaElevenLabs(
  header: string | undefined,
  corpo: Buffer,
  segreto: string,
  ora: number = Date.now(),
): boolean {
  if (!header) return false
  const parti = header.split(',')
  const t = parti.find((p) => p.startsWith('t='))?.slice(2)
  const v0 = parti.find((p) => p.startsWith('v0='))
  if (!t || !v0 || !/^\d+$/.test(t)) return false
  if (Number(t) * 1000 < ora - TOLLERANZA_MS) return false
  const atteso = 'v0=' + createHmac('sha256', segreto).update(`${t}.`).update(corpo).digest('hex')
  const a = Buffer.from(v0)
  const b = Buffer.from(atteso)
  return a.length === b.length && timingSafeEqual(a, b)
}

export interface BattutaTrascrizione {
  ruolo: 'agente' | 'cliente'
  testo: string
  /** Secondi dall'inizio della chiamata. */
  secondo: number | null
}

export interface DatiChiamata {
  conversation_id: string
  agent_ref: string | null
  riassunto: string | null
  esito: string | null
  durata_secondi: number | null
  iniziata_at: Date | null
  trascrizione: BattutaTrascrizione[]
  costo_crediti: number | null
  crediti_voce: number | null
  crediti_llm: number | null
  /** Stima in dollari di ElevenLabs: platform_price + llm_price. */
  costo_usd: number | null
  /** dev_discount: chiamata di test dal simulatore, scontata. */
  chiamata_test: boolean | null
}

const testo = (v: unknown) => (typeof v === 'string' && v.trim() ? v.trim() : null)
const numero = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : null)

/**
 * Toglie i tag di tono della sintesi vocale (`[professional]`, `[warm]`…):
 * guidano la voce, non sono parole dette, e nel popup per l'operatore
 * sarebbero rumore. Solo parole fra parentesi quadre all'inizio di una
 * frase o isolate: un "[DA VERIFICARE]" scritto in maiuscolo resta.
 */
export function senzaTagVoce(t: string): string {
  return t.replace(/\[[a-z][a-z ,-]{0,30}\]\s*/g, '').replace(/\s{2,}/g, ' ').trim() || t
}

/**
 * Dal payload `post_call_transcription` ai dati che servono. Le battute
 * senza testo (solo chiamate a strumenti) si saltano: in un popup per
 * l'operatore non dicono niente. null se non è una trascrizione o manca
 * l'id della conversazione.
 */
export function estraiChiamata(payload: unknown): DatiChiamata | null {
  const p = payload as { type?: unknown; data?: Record<string, unknown> } | null
  if (!p || p.type !== 'post_call_transcription' || !p.data) return null
  const d = p.data
  const conversation_id = testo(d['conversation_id'])
  if (!conversation_id) return null

  const metadata = (d['metadata'] ?? {}) as Record<string, unknown>
  const analysis = (d['analysis'] ?? {}) as Record<string, unknown>
  const inizio = numero(metadata['start_time_unix_secs'])
  const charging = (metadata['charging'] ?? {}) as Record<string, unknown>
  const prezzoVoce = numero(charging['platform_price'])
  const prezzoLlm = numero(charging['llm_price'])
  const intero = (v: unknown) => (numero(v) !== null ? Math.round(numero(v)!) : null)

  const trascrizione: BattutaTrascrizione[] = []
  for (const b of Array.isArray(d['transcript']) ? (d['transcript'] as Record<string, unknown>[]) : []) {
    const grezzo = testo(b['message'])
    const messaggio = grezzo && b['role'] === 'agent' ? senzaTagVoce(grezzo) : grezzo
    if (!messaggio) continue
    trascrizione.push({
      ruolo: b['role'] === 'agent' ? 'agente' : 'cliente',
      testo: messaggio,
      secondo: numero(b['time_in_call_secs']),
    })
  }

  return {
    conversation_id,
    agent_ref: testo(d['agent_id']),
    riassunto: testo(analysis['transcript_summary']),
    esito: testo(analysis['call_successful']),
    durata_secondi: numero(metadata['call_duration_secs']),
    iniziata_at: inizio !== null ? new Date(inizio * 1000) : null,
    trascrizione,
    costo_crediti: intero(metadata['cost']),
    crediti_voce: intero(charging['call_charge']),
    crediti_llm: intero(charging['llm_charge']),
    costo_usd: prezzoVoce === null && prezzoLlm === null ? null : (prezzoVoce ?? 0) + (prezzoLlm ?? 0),
    chiamata_test: typeof charging['dev_discount'] === 'boolean' ? (charging['dev_discount'] as boolean) : null,
  }
}

/** La nota breve nel ticket: inizia come le note dell'agente, così l'interfaccia offre "Vedi trascrizione". */
export function notaChiamata(durataSecondi: number | null): string {
  const durata =
    durataSecondi !== null
      ? ` Durata ${Math.floor(durataSecondi / 60)}:${String(Math.floor(durataSecondi % 60)).padStart(2, '0')}.`
      : ''
  return `Il cliente ha chiamato l'assistente vocale.${durata} Nessuna nuova richiesta lasciata: la trascrizione è disponibile.`
}
