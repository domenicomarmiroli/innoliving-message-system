import { dominioCombacia, dominioDi } from '../../connectors/mail/riconosci.js'
import { nomePerSaluto } from '../../connectors/reso/testo.js'

/**
 * Avviso automatico al cliente per una spedizione in giacenza o con un
 * problema di consegna (automazione `avviso_spedizione`, migrazione 0052).
 * Qui solo le decisioni e il testo, senza database né rete.
 */

export interface EventoCorriere {
  data: string
  ora?: string | null
  evento: string
  filiale?: string | null
}

export interface GiacenzaCorriere {
  numero?: string | null
  motivazione?: string | null
  disposizioni?: string | null
  stato?: string | null
}

/**
 * Si può scrivere a questo indirizzo? No se manca, se non è un indirizzo,
 * o se il dominio è fra gli esclusi (confronto per suffisso di etichetta,
 * come per la posta in arrivo: `codisto.com` copre `mail.codisto.com`).
 */
export function emailContattabile(email: string | null | undefined, dominiEsclusi: string[]): boolean {
  const dominio = dominioDi(email)
  if (!dominio) return false
  return !dominiEsclusi.some((r) => dominioCombacia(dominio, r))
}

function istante(e: EventoCorriere): number | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(e.data)) return null
  const ora = e.ora && /^\d{2}:\d{2}$/.test(e.ora) ? e.ora : '23:59'
  // Ora italiana: l'ora legale cambia di un'ora la finestra, ininfluente qui.
  const t = Date.parse(`${e.data}T${ora}:00+01:00`)
  return Number.isNaN(t) ? null : t
}

/**
 * L'ultimo evento del corriere è abbastanza recente da valere un avviso?
 * Accendere la regola non deve scrivere ai clienti per giacenze di
 * settimane fa, e uno stato riletto ogni giorno non è un fatto nuovo.
 */
export function eventoRecente(eventi: EventoCorriere[], ora: Date, maxOre: number): boolean {
  const tempi = eventi.map(istante).filter((t): t is number => t !== null)
  if (tempi.length === 0) return false
  return ora.getTime() - Math.max(...tempi) <= maxOre * 3_600_000
}

/**
 * Dal più recente. Si ordina solo per giorno: dentro lo stesso giorno vale
 * l'ordine di BRT, che li elenca già dal più recente, perché alcuni eventi
 * ("IN CONSEGNA") non hanno l'ora e non si possono collocare da soli.
 */
function dalPiuRecente(eventi: EventoCorriere[]): EventoCorriere[] {
  return [...eventi].sort((a, b) => (a.data < b.data ? 1 : a.data > b.data ? -1 : 0))
}

function dataBreve(d: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(d)
  return m ? `${m[3]}/${m[2]}` : d
}

/** Gli eventi, dal più recente, una riga ciascuno: "11/11 15:09 · POMEZIA (114) — LASCIATO AVVISO". */
export function righeEventi(eventi: EventoCorriere[], massimo = 6): string {
  return dalPiuRecente(eventi)
    .slice(0, massimo)
    .map((e) => {
      const quando = [dataBreve(e.data), e.ora].filter(Boolean).join(' ')
      const dove = e.filiale ? ` · ${e.filiale}` : ''
      return `- ${quando}${dove} — ${e.evento}`
    })
    .join('\n')
}

export interface DatiAvvisoSpedizione {
  nome_cliente: string | null
  numero_ordine: string
  tracking_numero: string
  tracking_link: string | null
  eventi: EventoCorriere[]
  giacenza: GiacenzaCorriere | null
}

const SEGNAPOSTO = /\{\{\s*([a-zA-Z0-9_.]+)\s*\}\}/g

/**
 * Compila oggetto e testo del modello. Un segnaposto che non conosciamo
 * è un errore: arriverebbe tale e quale al cliente.
 */
export function compilaAvvisoSpedizione(
  modello: string,
  d: DatiAvvisoSpedizione,
): { ok: true; testo: string } | { ok: false; motivo: string } {
  const recenti = dalPiuRecente(d.eventi)
  const valori: Record<string, string> = {
    'cliente.nome': d.nome_cliente?.trim() ? nomePerSaluto(d.nome_cliente) : 'Cliente',
    'ordine.numero': d.numero_ordine,
    'tracking.numero': d.tracking_numero,
    'tracking.link': d.tracking_link ?? '',
    'tracking.eventi': righeEventi(d.eventi),
    'tracking.ultimo_evento': recenti[0]?.evento ?? '',
    'giacenza.numero': d.giacenza?.numero?.trim() ?? '',
    'giacenza.motivo': d.giacenza?.motivazione?.trim() || recenti[0]?.evento || '',
  }
  const ignoti = new Set<string>()
  const righe: string[] = []
  for (const riga of modello.split('\n')) {
    const chiavi = [...riga.matchAll(SEGNAPOSTO)].map((m) => m[1]!)
    for (const k of chiavi) if (!(k in valori)) ignoti.add(k)
    // Una riga i cui dati mancano tutti ("Motivo: ") non si manda.
    if (chiavi.length > 0 && chiavi.every((k) => valori[k] === '')) continue
    righe.push(riga.replace(SEGNAPOSTO, (m, k: string) => (k in valori ? valori[k]! : m)))
  }
  if (ignoti.size > 0) return { ok: false, motivo: `segnaposto sconosciuti nel modello: ${[...ignoti].join(', ')}` }
  return { ok: true, testo: righe.join('\n').replace(/\n{3,}/g, '\n\n').trim() }
}
