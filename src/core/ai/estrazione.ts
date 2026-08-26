/**
 * Testo da un file caricato per la knowledge base. Solo PDF e testo
 * semplice: sono i due formati richiesti, non serve altro adesso.
 */

export async function estraiTesto(contenuto: Buffer, mime: string, nomeFile: string): Promise<string> {
  const estensione = nomeFile.toLowerCase().split('.').pop() ?? ''

  if (mime === 'application/pdf' || estensione === 'pdf') {
    const { PDFParse } = await import('pdf-parse')
    const parser = new PDFParse({ data: new Uint8Array(contenuto) })
    try {
      const risultato = await parser.getText()
      const testo = risultato.text.trim()
      if (!testo) {
        throw new Error('Il PDF non contiene testo estraibile (potrebbe essere una scansione senza OCR).')
      }
      return testo
    } finally {
      await parser.destroy()
    }
  }

  if (mime.startsWith('text/') || estensione === 'txt' || estensione === 'md') {
    const testo = contenuto.toString('utf8').trim()
    if (!testo) throw new Error('Il file è vuoto.')
    return testo
  }

  throw new Error(`Formato non supportato per la knowledge base: ${mime || estensione || 'sconosciuto'} (solo PDF e testo).`)
}
