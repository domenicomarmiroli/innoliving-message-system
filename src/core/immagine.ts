import sharp from 'sharp'

/**
 * Larghezza e altezza di un'immagine, se il formato è leggibile.
 *
 * DEBITO: sharp/libvips, nella build che npm installa di default, NON
 * legge in modo affidabile HEIC/HEIF — il formato in cui arrivano le
 * foto da iPhone. Qui si ripiega su null invece di fallire o di
 * inventare una conversione non verificata: meglio un allegato senza
 * dimensioni che un errore che blocca l'ingestione. La conversione
 * HEIC->JPEG per la visualizzazione resta da costruire (vedi CLAUDE.md).
 */
export async function dimensioniImmagine(
  contenuto: Buffer,
): Promise<{ larghezza: number; altezza: number } | null> {
  try {
    const info = await sharp(contenuto).metadata()
    if (!info.width || !info.height) return null
    return { larghezza: info.width, altezza: info.height }
  } catch {
    return null
  }
}
