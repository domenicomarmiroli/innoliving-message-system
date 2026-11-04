export type EsitoDraft = 'usata_invariata' | 'usata_modificata' | 'ignorata'

/**
 * Confronta il testo proposto dal modello con quello davvero inviato,
 * per il passo di verifica su casi reali (ai_draft.outcome). Un confronto
 * per uguaglianza dopo trim: qualunque correzione dell'operatore, anche
 * minima, conta come modifica — è il segnale che ci interessa, non la
 * distanza testuale.
 */
export function calcolaEsito(draftText: string, testoInviato: string): EsitoDraft {
  return draftText.trim() === testoInviato.trim() ? 'usata_invariata' : 'usata_modificata'
}

function parole(t: string): Set<string> {
  return new Set(
    t
      .toLowerCase()
      .split(/[^a-zàèéìòù0-9]+/)
      .filter((p) => p.length > 2),
  )
}

/** Somiglianza fra due testi (0-1): parole in comune su parole totali. */
export function somiglianza(a: string, b: string): number {
  const pa = parole(a)
  const pb = parole(b)
  if (pa.size === 0 || pb.size === 0) return 0
  let comuni = 0
  for (const p of pa) if (pb.has(p)) comuni += 1
  return comuni / (pa.size + pb.size - comuni)
}

/** Sotto questa soglia il testo inviato è stato scritto da zero. */
export const SOGLIA_BOZZA_USATA = 0.35

/**
 * Esito quando l'interfaccia NON ha passato `draft_id` (è il caso reale:
 * 855 invii e nessuno con draft_id). Si guarda la bozza più recente
 * ancora senza esito: abbastanza simile al testo inviato = usata
 * (invariata o modificata), altrimenti l'operatore l'ha ignorata e ha
 * scritto da sé. Così la percentuale di bozze usate si può misurare
 * anche se l'interfaccia non collega nulla.
 */
export function esitoSenzaId(draftText: string, testoInviato: string): EsitoDraft {
  if (draftText.trim() === testoInviato.trim()) return 'usata_invariata'
  return somiglianza(draftText, testoInviato) >= SOGLIA_BOZZA_USATA ? 'usata_modificata' : 'ignorata'
}
