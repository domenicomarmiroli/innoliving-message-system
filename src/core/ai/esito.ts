export type EsitoDraft = 'usata_invariata' | 'usata_modificata'

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
