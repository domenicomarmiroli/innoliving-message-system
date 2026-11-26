/**
 * Mail al centro assistenza esterno (il partner che gestisce le riparazioni
 * in garanzia su Zendesk). Parte pura: niente database, niente rete.
 *
 * Chiesto da Domenico il 2026-11-26. Il partner vuole:
 *  - oggetto "RICHIESTA PORTALE GARANZIA <Nome Cliente>";
 *  - nel testo tutti i dati del cliente, scontrino o fattura con la data,
 *    il prodotto, la scadenza della garanzia, il valore pagato, l'indirizzo
 *    e il problema.
 * Il partner prova a leggere il testo in automatico per compilare il suo
 * ticket: per questo le righe sono SEMPRE le stesse, nello stesso ordine,
 * nella forma "Etichetta: valore", anche quando il valore manca.
 * Il testo libero dell'operatore va solo nell'ultima voce, "Note".
 */

export interface ConfigAssistenzaPartner {
  /** Indirizzo della casella collegata al sistema di ticket del partner. */
  email: string | null
  prefisso_oggetto: string
  /** Come l'interfaccia chiama il partner ("Centro assistenza ..."). */
  nome: string
}

export const CONFIG_PARTNER_PREDEFINITA: ConfigAssistenzaPartner = {
  email: null,
  prefisso_oggetto: 'RICHIESTA PORTALE GARANZIA',
  nome: 'Centro assistenza',
}

export function leggiConfigPartner(valore: unknown): ConfigAssistenzaPartner {
  const v = (valore && typeof valore === 'object' ? valore : {}) as Partial<ConfigAssistenzaPartner>
  return { ...CONFIG_PARTNER_PREDEFINITA, ...v }
}

/** I dati della pratica, già raccolti dal ticket. Tutti facoltativi. */
export interface DatiPratica {
  numero_ticket: string | null
  nome: string | null
  email: string | null
  telefono: string | null
  indirizzo: string | null
  cap: string | null
  citta: string | null
  provincia: string | null
  paese: string | null
  marchio: string | null
  prodotto: string | null
  codice: string | null
  seriale: string | null
  canale_acquisto: string | null
  negozio: string | null
  numero_documento: string | null
  data_acquisto: string | null
  valore_pagato: number | null
  scadenza_garanzia: string | null
  copertura_mesi: number | null
  estensione: string | null
  certificato: string | null
  problema: string | null
}

export const PRATICA_VUOTA: DatiPratica = {
  numero_ticket: null, nome: null, email: null, telefono: null,
  indirizzo: null, cap: null, citta: null, provincia: null, paese: null,
  marchio: null, prodotto: null, codice: null, seriale: null,
  canale_acquisto: null, negozio: null, numero_documento: null, data_acquisto: null,
  valore_pagato: null, scadenza_garanzia: null, copertura_mesi: null,
  estensione: null, certificato: null, problema: null,
}

const testo = (v: unknown): string | null => (typeof v === 'string' && v.trim() ? v.trim() : null)
const numero = (v: unknown): number | null => {
  const n = typeof v === 'string' ? Number(v.replace(',', '.')) : v
  return typeof n === 'number' && Number.isFinite(n) && n > 0 ? Math.round(n * 100) / 100 : null
}

/** "2026-06-15" → "15/06/2026"; una data già italiana resta com'è. */
export function dataItaliana(v: string | null): string | null {
  if (!v) return null
  const iso = v.match(/^(\d{4})-(\d{2})-(\d{2})/)
  return iso ? `${iso[3]}/${iso[2]}/${iso[1]}` : v
}

/** Dati strutturati del portale garanzie (message.raw.garanzia). */
export function daGaranzia(g: Record<string, unknown> | null | undefined): Partial<DatiPratica> {
  if (!g) return {}
  const ind = (g['indirizzo_spedizione'] && typeof g['indirizzo_spedizione'] === 'object'
    ? g['indirizzo_spedizione']
    : null) as Record<string, unknown> | null
  const nomeIndirizzo = [testo(ind?.['nome']), testo(ind?.['cognome'])].filter(Boolean).join(' ') || null
  const via = ind
    ? [testo(ind['indirizzo']), testo(ind['indirizzo2']), testo(ind['presso']) ? `presso ${testo(ind['presso'])}` : null]
        .filter(Boolean).join(', ') || null
    : null
  const copertura = typeof g['copertura_mesi'] === 'number' ? (g['copertura_mesi'] as number) : null
  return {
    nome: testo(g['intestatario']) ?? nomeIndirizzo,
    telefono: testo(g['telefono']) ?? testo(ind?.['telefono']),
    indirizzo: via ?? testo(g['indirizzo_ritiro']),
    cap: testo(ind?.['cap']),
    citta: testo(ind?.['citta']),
    provincia: testo(ind?.['provincia'])?.toUpperCase() ?? null,
    paese: testo(ind?.['paese'])?.toUpperCase() ?? null,
    marchio: testo(g['brand']),
    prodotto: testo(g['prodotto']),
    codice: testo(g['codice_modello'])?.toUpperCase() ?? null,
    seriale: testo(g['seriale']),
    canale_acquisto: testo(g['canale_acquisto']),
    negozio: testo(g['negozio']),
    numero_documento: testo(g['numero_scontrino']) ?? testo(g['numero_ordine']),
    data_acquisto: dataItaliana(testo(g['data_acquisto'])),
    valore_pagato: numero(g['valore_prodotto']),
    scadenza_garanzia: dataItaliana(testo(g['scadenza'])),
    copertura_mesi: copertura,
    estensione: testo(g['estensione']),
    certificato: testo(g['certificato']),
    problema: testo(g['problema']),
  }
}

/** Righe "Etichetta: valore" che il portale scriveva nel testo prima dei dati strutturati. */
const RIGHE_TESTO: [RegExp, keyof DatiPratica][] = [
  [/^\s*Prodotto\s*:\s*(.+)$/im, 'prodotto'],
  [/^\s*Codice\s*:\s*(.+)$/im, 'codice'],
  [/^\s*Data di acquisto\s*:\s*(.+)$/im, 'data_acquisto'],
  [/^\s*Garanzia valida fino al\s*:\s*(.+)$/im, 'scadenza_garanzia'],
  [/^\s*Telefono\s*:\s*(.+)$/im, 'telefono'],
  [/^\s*Numero (?:scontrino|ordine|fattura)\s*:\s*(.+)$/im, 'numero_documento'],
  [/^\s*Seriale\s*:\s*(.+)$/im, 'seriale'],
]

/**
 * Dal testo del primo messaggio del cliente: le righe note, e come problema
 * quello che sta prima della prima riga nota (o tutto il testo se non ce ne
 * sono).
 */
export function daTesto(t: string | null): Partial<DatiPratica> {
  if (!t?.trim()) return {}
  const out: Partial<DatiPratica> = {}
  let primaRiga = t.length
  for (const [re, campo] of RIGHE_TESTO) {
    const m = re.exec(t)
    if (m) {
      ;(out as Record<string, unknown>)[campo] = campo === 'codice' ? m[1]!.trim().toUpperCase() : m[1]!.trim()
      primaRiga = Math.min(primaRiga, m.index)
    }
  }
  const problema = t.slice(0, primaRiga).trim()
  if (problema) out.problema = problema
  return out
}

/** Unisce le fonti: vince la prima che ha il valore. */
export function unisci(...fonti: Partial<DatiPratica>[]): DatiPratica {
  const out: DatiPratica = { ...PRATICA_VUOTA }
  for (const k of Object.keys(PRATICA_VUOTA) as (keyof DatiPratica)[]) {
    for (const f of fonti) {
      const v = f[k]
      if (v !== null && v !== undefined && v !== '') {
        ;(out as unknown as Record<string, unknown>)[k] = v
        break
      }
    }
  }
  return out
}

const euro = (n: number | null) => (n === null ? '' : `${n.toFixed(2).replace('.', ',')} EUR`)

export function oggettoPartner(config: ConfigAssistenzaPartner, d: DatiPratica): string {
  return [config.prefisso_oggetto, d.nome].filter(Boolean).join(' ').slice(0, 300)
}

/** Il testo della mail: sempre le stesse righe, nello stesso ordine. */
export function testoPartner(d: DatiPratica, nota: string | null, allegati = 0): string {
  const r = (etichetta: string, v: string | number | null) => {
    const s = String(v ?? '')
    return `${etichetta}:${s.startsWith('\n') ? '' : ' '}${s}`.trimEnd()
  }
  return [
    'RICHIESTA PORTALE GARANZIA',
    r('Riferimento nostro ticket', d.numero_ticket ? `#${d.numero_ticket}` : null),
    '',
    'CLIENTE',
    r('Nome e cognome', d.nome),
    r('Email', d.email),
    r('Telefono', d.telefono),
    r('Indirizzo', d.indirizzo),
    r('CAP', d.cap),
    r('Citta', d.citta),
    r('Provincia', d.provincia),
    r('Paese', d.paese),
    '',
    'PRODOTTO',
    r('Marchio', d.marchio),
    r('Prodotto', d.prodotto),
    r('Codice prodotto', d.codice),
    r('Numero di serie', d.seriale),
    '',
    'ACQUISTO',
    r('Canale di acquisto', d.canale_acquisto),
    r('Negozio', d.negozio),
    r('Numero scontrino/fattura', d.numero_documento),
    r('Data di acquisto', d.data_acquisto),
    r('Valore pagato (IVA inclusa)', euro(d.valore_pagato)),
    '',
    'GARANZIA',
    r('Scadenza garanzia', d.scadenza_garanzia),
    r('Copertura (mesi)', d.copertura_mesi),
    r('Estensione', d.estensione),
    r('Certificato', d.certificato),
    '',
    'PROBLEMA',
    r('Descrizione del problema', d.problema ? `\n${d.problema}` : null),
    '',
    r('Note', nota?.trim() ? `\n${nota.trim()}` : null),
    ...(allegati > 0 ? ['', `In allegato ${allegati} file inviati dal cliente (scontrino, foto).`] : []),
  ].join('\n')
}
