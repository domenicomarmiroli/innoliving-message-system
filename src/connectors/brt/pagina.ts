/**
 * Lettura della pagina pubblica di tracking BRT (la parte pura).
 *
 * Ripiego dichiarato, in attesa di un servizio via API: l'API REST di BRT
 * cerca solo per `trackingByParcelID`, che esiste solo alla creazione della
 * spedizione, mentre noi abbiamo il numero di spedizione a 12 cifre — e la
 * pagina pubblica accetta proprio quello. Non è un'interfaccia stabile:
 * se BRT la cambia, `leggiPagina()` restituisce `riconosciuta: false` e il
 * chiamante lo registra come anomalia invece di scrivere uno stato
 * sbagliato.
 *
 * Esemplari reali in `test/fixtures/brt/` (06/10): una spedizione in
 * viaggio, una consegnata dopo una giacenza, un numero inesistente.
 */

export interface EventoBrt {
  /** ISO, `YYYY-MM-DD`. */
  data: string
  /** `HH:MM`, a volte assente sulla pagina. */
  ora: string | null
  filiale: string | null
  evento: string
}

export interface GiacenzaBrt {
  numero: string | null
  aperta_il: string | null
  /** "Evasa" quando la giacenza è risolta. */
  stato: string | null
  motivazione: string | null
  disposizioni: string | null
}

export type StatoBrt =
  | 'spedito'
  /** Tornato al mittente (rifiutato, non consegnabile): l'ultimo "CONSEGNATA" è la riconsegna a noi. */
  | 'rientrato'
  | 'in_transito'
  | 'in_consegna'
  | 'consegnato'
  | 'giacenza'
  | 'problema'

export type EsitoPagina =
  | { riconosciuta: true; trovata: false }
  | {
      riconosciuta: true
      trovata: true
      /** Dal più recente al più vecchio, come sulla pagina. */
      eventi: EventoBrt[]
      consegna_prevista: string | null
      giacenza: GiacenzaBrt | null
      stato: StatoBrt
    }
  | { riconosciuta: false; motivo: string }

const ENTITA: Record<string, string> = { '&nbsp;': ' ', '&amp;': '&', '&quot;': '"', '&#39;': "'", '&lt;': '<', '&gt;': '>' }

function testo(html: string): string {
  return html
    .replace(/<br\s*\/?>/gi, ' ')
    .replace(/<[^>]*>/g, ' ')
    .replace(/&[a-z#0-9]+;/gi, (e) => ENTITA[e.toLowerCase()] ?? ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

/** "05.10.2026" → "2026-10-05". */
function dataIso(s: string | null | undefined): string | null {
  const m = s?.match(/(\d{2})\.(\d{2})\.(\d{4})/)
  return m ? `${m[3]}-${m[2]}-${m[1]}` : null
}

function celle(riga: string): string[] {
  return [...riga.matchAll(/<td[^>]*>([\s\S]*?)<\/td>/gi)].map((m) => testo(m[1]!))
}

function righe(html: string): string[] {
  return [...html.matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/gi)].map((m) => m[1]!)
}

/** La tabella che segue l'etichetta con questo id (`diz_386` = Eventi, `diz_149` = Giacenza). */
function tabellaDopo(html: string, idEtichetta: string): string | null {
  const i = html.indexOf(`id="${idEtichetta}"`)
  if (i < 0) return null
  const fine = html.indexOf('</table>', i)
  return fine < 0 ? null : html.slice(i, fine)
}

/** Coppie etichetta → valore delle righe a due celle. */
function campi(html: string): Map<string, string> {
  const m = new Map<string, string>()
  for (const r of righe(html)) {
    const c = celle(r)
    if (c.length === 2 && c[0]) m.set(c[0].toLowerCase(), c[1]!)
  }
  return m
}

const PROBLEMA =
  /DESTINATAR|SCONOSC|ASSENTE|RIFIUT|DANNEGG|SMARR|MANCATA|RESPINT|IRREPERIB|INCOMPLET|INESATT|CHIUS[OA]|NON CONSEGN|RESO AL MITT|AVARIA|MANOMESS/
const CONSEGNATA = /^CONSEGNAT[AO]/

/**
 * Lo stato riassunto, dall'ultimo evento e dalla giacenza. Ordine delle
 * regole: rientro al mittente prima di tutto; poi consegnata (una giacenza
 * risolta resta nella pagina anche dopo la consegna, come nell'esemplare
 * reale); poi giacenza
 * ancora aperta; poi un ultimo evento problematico.
 */
const RIENTRO = /RESO (AL )?MITT|RIENTR|RITORNO AL MITT|RESTITUIT/

/**
 * Tornata al mittente? Caso reale (06/10, 066061609726): RIFIUTA SENZA
 * MOTIVAZIONE → giacenza con disposizione RIENTRO → RESO MITTENTE →
 * CONSEGNATA. Quell'ultimo "CONSEGNATA" è la riconsegna a noi, non al
 * cliente: senza questa regola lo stato diceva "consegnato".
 */
export function rientrataAlMittente(eventi: EventoBrt[], giacenza: GiacenzaBrt | null): boolean {
  if (eventi.some((e) => RIENTRO.test(e.evento.toUpperCase()))) return true
  return RIENTRO.test((giacenza?.disposizioni ?? '').toUpperCase())
}

export function statoDaEventi(eventi: EventoBrt[], giacenza: GiacenzaBrt | null): StatoBrt {
  const ultimo = eventi[0]?.evento.toUpperCase() ?? ''
  if (rientrataAlMittente(eventi, giacenza)) return 'rientrato'
  if (CONSEGNATA.test(ultimo)) return 'consegnato'
  if (giacenza && !/evas|chius|risolt/i.test(giacenza.stato ?? '')) return 'giacenza'
  if (/GIACENZA/.test(ultimo)) return 'giacenza'
  if (PROBLEMA.test(ultimo)) return 'problema'
  if (/IN CONSEGNA/.test(ultimo)) return 'in_consegna'
  const solo_dati = eventi.every((e) => /DATI SPEDIZ/i.test(e.evento))
  return solo_dati ? 'spedito' : 'in_transito'
}

export function leggiPagina(html: string): EsitoPagina {
  if (/non trovata oppure ancora in elaborazione/i.test(testo(html))) {
    return { riconosciuta: true, trovata: false }
  }

  const tabellaEventi = tabellaDopo(html, 'diz_386')
  if (!tabellaEventi) {
    return { riconosciuta: false, motivo: 'tabella degli eventi non trovata' }
  }

  const eventi: EventoBrt[] = []
  for (const r of righe(tabellaEventi)) {
    const c = celle(r)
    if (c.length < 4) continue
    const data = dataIso(c[0])
    if (!data || !c[3]) continue
    const ora = c[1]?.match(/^(\d{2})\.(\d{2})$/)
    eventi.push({ data, ora: ora ? `${ora[1]}:${ora[2]}` : null, filiale: c[2] || null, evento: c[3] })
  }
  if (eventi.length === 0) {
    return { riconosciuta: false, motivo: 'tabella degli eventi senza righe leggibili' }
  }

  const generali = campi(html.slice(0, html.indexOf('id="diz_386"')))
  const consegna_prevista = dataIso(generali.get('consegna stimata') ?? generali.get('consegna prevista'))

  let giacenza: GiacenzaBrt | null = null
  const tabellaGiacenza = tabellaDopo(html, 'diz_149')
  if (tabellaGiacenza) {
    const g = campi(tabellaGiacenza)
    giacenza = {
      numero: g.get('n. giacenza') ?? null,
      aperta_il: dataIso(g.get('aperta il')),
      stato: g.get('evento') ?? null,
      motivazione: g.get('motivazione') ?? null,
      disposizioni: g.get('disposizioni') ?? null,
    }
  }

  return {
    riconosciuta: true,
    trovata: true,
    eventi,
    consegna_prevista,
    giacenza,
    stato: statoDaEventi(eventi, giacenza),
  }
}

export function urlPaginaBrt(numero: string): string {
  return `https://vas.brt.it/vas/sped_det_show.hsm?referer=sped_numspe_par.htm&Nspediz=${encodeURIComponent(numero)}`
}
