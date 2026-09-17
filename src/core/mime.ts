/**
 * Tipo MIME dedotto dall'estensione del nome file.
 *
 * Serve dove la sorgente non lo dichiara: l'elenco allegati di Mirakl
 * (M11) riporta solo id, nome e dimensione, e il download (M13) può
 * rispondere con un `Content-Type` generico. Senza tipo l'allegato
 * finisce su Storage come `application/octet-stream` e il browser lo
 * scarica invece di mostrarlo — una foto di un prodotto danneggiato si
 * deve poter guardare, non salvare.
 *
 * Volutamente corta: i formati che i clienti mandano davvero. Un tipo
 * sconosciuto resta `null`, che è un'informazione onesta — meglio di un
 * tipo inventato, che farebbe fallire la visualizzazione in un modo più
 * difficile da capire.
 */
const PER_ESTENSIONE: Record<string, string> = {
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  png: 'image/png',
  gif: 'image/gif',
  webp: 'image/webp',
  heic: 'image/heic',
  heif: 'image/heif',
  bmp: 'image/bmp',
  tif: 'image/tiff',
  tiff: 'image/tiff',
  pdf: 'application/pdf',
  txt: 'text/plain',
  csv: 'text/csv',
  doc: 'application/msword',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  xls: 'application/vnd.ms-excel',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
}

/** Tipi che non dicono niente: vale la pena provare col nome del file. */
const GENERICI = ['', 'application/octet-stream', 'binary/octet-stream']

export function mimeDaNomeFile(nomeFile: string | null | undefined): string | null {
  if (!nomeFile) return null
  const estensione = nomeFile.toLowerCase().split('.').pop() ?? ''
  return PER_ESTENSIONE[estensione] ?? null
}

/**
 * Il tipo dichiarato, se dice qualcosa; altrimenti quello dedotto dal
 * nome. Un `Content-Type` con parametri (`image/jpeg; charset=binary`)
 * viene ridotto al solo tipo.
 */
export function mimeMigliore(
  dichiarato: string | null | undefined,
  nomeFile: string | null | undefined,
): string | null {
  const pulito = (dichiarato ?? '').split(';')[0]?.trim().toLowerCase() ?? ''
  if (!GENERICI.includes(pulito)) return pulito
  return mimeDaNomeFile(nomeFile)
}
