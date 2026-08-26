/**
 * Pulizia del corpo per la lettura.
 *
 * Le email dei relay sono per il 90% impalcatura: intestazioni di
 * cortesia, link "risolvi caso", note legali, copyright. L'operatore
 * deve vedere quello che ha scritto il cliente, non cercarlo.
 *
 * REGOLA: il testo integrale non si perde mai. Resta in `message.raw`,
 * da cui si riprocessa (regola 4 di CLAUDE.md). Qui produciamo solo la
 * versione che finisce in `body_text`, cioè quella che si legge.
 *
 * E una seconda regola, altrettanto importante: **se la pulizia non
 * riconosce niente, restituisce il testo originale**. Un corpo vuoto in
 * interfaccia è molto peggio di un corpo rumoroso: il rumore si legge
 * lo stesso, il vuoto fa perdere il messaggio.
 */

export interface RegoleTesto {
  /** Coppie [inizio, fine]: si tiene ciò che sta in mezzo. */
  delimitatori: Array<[string, string]>
  /** Da qui in poi si taglia: note legali, copyright, link di servizio. */
  tagli: string[]
}

/**
 * Delimitatori predefiniti, indipendenti dalla lingua.
 *
 * Amazon incornicia il messaggio dell'acquirente fra due righe di
 * trattini; l'apertura ha i due punti, la chiusura no:
 *
 *   ------------- Messaggio: -------------
 *   ...testo del cliente...
 *   ------------- Fine messaggio -------------
 *
 * La parola cambia con il marketplace (Nachricht, Message, Mensaje),
 * la forma no: per questo il riconoscimento guarda la struttura e non
 * le parole. Chi vuole essere più preciso mette i propri delimitatori
 * in channel_account.config.body_extract.
 */
const DELIMITATORI_PREDEFINITI: Array<[string, string]> = [
  ['^-{5,}[^\\n:]{0,40}:\\s*-{5,}\\s*$', '^-{5,}[^\\n:]{0,40}-{5,}\\s*$'],
]

/**
 * Tagli predefiniti: la coda di servizio che segue ogni email di relay.
 * Sono ancore prudenti — meglio lasciare due righe di troppo che
 * mangiare la fine di un messaggio.
 */
const TAGLI_PREDEFINITI: string[] = [
  '^-{20,}\\s*$',
  '^\\s*Copyright \\d{4}\\b',
  '^\\s*SPC-[A-Z]{2}\\w*-\\d+\\s*$',
]

function compila(fonti: string[]): RegExp[] {
  const compilate: RegExp[] = []
  for (const f of fonti) {
    try {
      compilate.push(new RegExp(f, 'im'))
    } catch {
      // Un'espressione scritta male in configurazione non deve far
      // sparire il corpo del messaggio: si ignora e si va avanti.
    }
  }
  return compilate
}

export function regoleDaConfig(config: unknown): RegoleTesto {
  const c = (config ?? {}) as {
    body_extract?: unknown
    body_cut?: unknown
  }

  const delimitatori: Array<[string, string]> = Array.isArray(c.body_extract)
    ? c.body_extract
        .filter(
          (v): v is [string, string] =>
            Array.isArray(v) &&
            v.length === 2 &&
            typeof v[0] === 'string' &&
            typeof v[1] === 'string',
        )
        .map((v) => [v[0], v[1]])
    : []

  const tagli: string[] = Array.isArray(c.body_cut)
    ? c.body_cut.filter((v): v is string => typeof v === 'string')
    : []

  return {
    delimitatori: delimitatori.length > 0 ? delimitatori : DELIMITATORI_PREDEFINITI,
    tagli: tagli.length > 0 ? tagli : TAGLI_PREDEFINITI,
  }
}

export function ripulisci(testo: string | null, regole: RegoleTesto): string | null {
  if (!testo) return testo

  const righe = testo.split(/\r?\n/)

  // --- 1. Il messaggio incorniciato ------------------------------------
  for (const [inizioFonte, fineFonte] of regole.delimitatori) {
    const [inizio, fine] = compila([inizioFonte, fineFonte])
    if (!inizio || !fine) continue

    const da = righe.findIndex((r) => inizio.test(r))
    if (da === -1) continue
    // La chiusura si cerca DOPO l'apertura: la stessa riga di trattini
    // non deve chiudere ciò che ha appena aperto.
    const a = righe.findIndex((r, i) => i > da && fine.test(r))
    if (a === -1) continue

    const dentro = righe.slice(da + 1, a).join('\n').trim()
    if (dentro.length > 0) return dentro
  }

  // --- 2. Taglio della coda di servizio ---------------------------------
  const tagli = compila(regole.tagli)
  let fine = righe.length
  for (const t of tagli) {
    const dove = righe.findIndex((r) => t.test(r))
    if (dove > 0 && dove < fine) fine = dove
  }

  const tagliato = righe.slice(0, fine).join('\n').trim()

  // --- 3. Mai restituire il vuoto ---------------------------------------
  return tagliato.length > 0 ? tagliato : testo.trim()
}
