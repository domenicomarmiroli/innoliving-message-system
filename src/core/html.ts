/**
 * Estrazione di campi da HTML, e riduzione a testo semplice.
 *
 * `testoPulito` la usano sia resi.ts/rimborsi.ts (per leggere una email
 * di notifica Amazon) sia mirakl/normalize.ts (per ricavare un
 * body_text leggibile quando il corpo di un messaggio Mirakl è HTML,
 * non testo semplice — un caso reale, non ipotetico: i messaggi di
 * sistema Mirakl arrivano formattati con <b>/<ul>/<a>). Le altre
 * funzioni (`campoEtichettaGrassetto`, `campoEtichettaSemplice`,
 * `estraiRigheTabella`) restano specifiche del formato a lista + tabella
 * delle notifiche Amazon.
 */

/** Toglie i tag, normalizza gli spazi, decodifica le poche entità HTML che contano. */
export function testoPulito(html: string): string {
  return html
    .replace(/<[^>]+>/g, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

/** Un campo scritto come `<b>Etichetta:</b> valore` nella lista riassuntiva. */
export function campoEtichettaGrassetto(html: string, etichetta: string): string | null {
  const escaped = etichetta.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const re = new RegExp(`<b>\\s*${escaped}\\s*<\\/b>\\s*([^<]+)`, 'i')
  const trovato = html.match(re)
  return trovato?.[1] ? testoPulito(trovato[1]) : null
}

/** Un campo scritto come testo semplice `Etichetta: valore`, senza `<b>`. */
export function campoEtichettaSemplice(html: string, etichetta: string): string | null {
  const escaped = etichetta.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const re = new RegExp(`${escaped}\\s*:\\s*([^<]+)`, 'i')
  const trovato = html.match(re)
  return trovato?.[1] ? testoPulito(trovato[1]) : null
}

/**
 * Le righe della tabella riassuntiva, come array di celle pulite.
 *
 * Riconosciuta da `cellpadding="10"`: non elegante, ma è l'unico
 * marcatore stabile senza un secondo esemplare che confermi se cambia da
 * un'email all'altra. Tollerante: una tabella diversa da quella attesa
 * produce un elenco vuoto, non un'eccezione — l'email resta comunque in
 * `raw`. Non assume il numero di colonne: lo decide chi chiama, in base
 * al formato che sta leggendo.
 */
export function estraiRigheTabella(html: string): string[][] {
  const tabella = html.match(/<table[^>]*cellpadding="10"[^>]*>([\s\S]*?)<\/table>/i)
  if (!tabella?.[1]) return []

  const righe: string[][] = []
  for (const rigaMatch of tabella[1].matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/gi)) {
    const rigaHtml = rigaMatch[1] ?? ''
    if (/<th[\s>]/i.test(rigaHtml)) continue // riga di intestazione

    const celle = [...rigaHtml.matchAll(/<td[^>]*>([\s\S]*?)<\/td>/gi)].map((m) =>
      testoPulito(m[1] ?? ''),
    )
    if (celle.length === 0) continue
    righe.push(celle)
  }
  return righe
}
