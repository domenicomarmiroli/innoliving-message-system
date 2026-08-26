import sharp from 'sharp'

/**
 * Normalizzazione degli allegati in uscita, per canale.
 *
 * La trappola, verificata e non dedotta: su Amazon il JPG non è un
 * allegato valido. Amazon accetta solo pdf, png, txt, doc, docx, tiff e
 * bmp, con un massimo di 6 MB (consigliato restare fra 1 e 5). Il JPG è
 * esattamente il formato in cui arrivano le foto dai telefoni dei
 * clienti: senza conversione automatica, l'agente allega una foto,
 * l'invio fallisce o l'allegato sparisce, e nessuno se ne accorge finché
 * il cliente non riscrive arrabbiato. Rifiutare non è un'opzione qui:
 * la funzione deve convertire, non lamentarsi.
 */

export interface FileInput {
  nome_file: string
  mime: string
  contenuto: Buffer
}

export interface FilePronto {
  nome_file: string
  mime: string
  contenuto: Buffer
  /** Mime originale, solo se è stata fatta una conversione. */
  convertito_da: string | null
  note: string[]
}

export type EsitoNormalizza =
  | ({ ok: true } & FilePronto)
  | { ok: false; motivo: string }

const AMAZON_MASSIMO_BYTE = 6 * 1024 * 1024
const AMAZON_OBIETTIVO_BYTE = 4 * 1024 * 1024
const AMAZON_TIPI_AMMESSI = new Set([
  'application/pdf',
  'image/png',
  'text/plain',
  'application/msword',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'image/tiff',
  'image/bmp',
])
const IMMAGINI_CONVERTIBILI = new Set(['image/jpeg', 'image/jpg'])
// HEIC/HEIF: DEBITO dichiarato in CLAUDE.md. La build di sharp/libvips
// installata da npm non le legge in modo affidabile — serve una
// libreria dedicata per quel formato, non assunta qui.
const HEIC = new Set(['image/heic', 'image/heif'])

export async function prepare(kind: string, file: FileInput): Promise<EsitoNormalizza> {
  if (kind === 'amazon') return prepareAmazon(file)
  // Mirakl: il meccanismo di invio allegati (multipart su M12, o
  // documenti d'ordine via OR74) non è ancora deciso — vedi CLAUDE.md.
  // Shopify ed email: nessuna restrizione nota.
  return { ok: true, ...file, convertito_da: null, note: [] }
}

async function prepareAmazon(file: FileInput): Promise<EsitoNormalizza> {
  const note: string[] = []
  let mime = file.mime
  let contenuto = file.contenuto
  let convertito_da: string | null = null
  let nome_file = file.nome_file

  if (HEIC.has(mime)) {
    return {
      ok: false,
      motivo:
        'Formato HEIC non convertibile in questa versione: serve prima convertirlo ' +
        '(ad esempio in JPEG) prima di allegarlo. È un debito noto, non un rifiuto definitivo.',
    }
  }

  if (IMMAGINI_CONVERTIBILI.has(mime)) {
    try {
      contenuto = await sharp(file.contenuto).png().toBuffer()
    } catch (errore) {
      return {
        ok: false,
        motivo: `Conversione in PNG fallita: ${errore instanceof Error ? errore.message : String(errore)}`,
      }
    }
    convertito_da = mime
    mime = 'image/png'
    nome_file = sostituisciEstensione(nome_file, 'png')
    note.push('Convertito da JPG a PNG: Amazon non accetta il JPG come allegato.')
  } else if (!AMAZON_TIPI_AMMESSI.has(mime)) {
    return {
      ok: false,
      motivo: `Tipo di file "${mime}" non ammesso su Amazon (ammessi: pdf, png, txt, doc, docx, tiff, bmp).`,
    }
  }

  if (contenuto.byteLength > AMAZON_MASSIMO_BYTE) {
    if (mime === 'image/png' || mime === 'image/tiff' || mime === 'image/bmp') {
      const ricompresso = await ricomprimiImmagine(contenuto, AMAZON_OBIETTIVO_BYTE)
      if (!ricomprimiOk(ricompresso, AMAZON_MASSIMO_BYTE)) {
        return {
          ok: false,
          motivo:
            `L'immagine resta sopra i 6 MB anche dopo la ricompressione ` +
            `(${(ricompresso.byteLength / 1024 / 1024).toFixed(1)} MB): va ridotta a mano prima di allegarla.`,
        }
      }
      contenuto = ricompresso
      note.push('Ridimensionata per stare sotto il limite di 6 MB di Amazon.')
    } else {
      return {
        ok: false,
        motivo:
          `Il file supera i 6 MB ammessi da Amazon (${(contenuto.byteLength / 1024 / 1024).toFixed(1)} MB) ` +
          'e non è un\'immagine: non può essere ricompresso automaticamente.',
      }
    }
  }

  return { ok: true, nome_file, mime, contenuto, convertito_da, note }
}

/**
 * Riduce le dimensioni in pixel finché il file non sta sotto l'obiettivo,
 * o finché non ha più senso ridurre oltre. Per un PNG, che è senza
 * perdita, ridurre i pixel è l'unica leva reale — non esiste un
 * parametro di qualità come per il JPEG.
 */
async function ricomprimiImmagine(contenuto: Buffer, obiettivoByte: number): Promise<Buffer> {
  let corrente = contenuto
  let scala = 0.8

  for (let tentativo = 0; tentativo < 6 && corrente.byteLength > obiettivoByte; tentativo += 1) {
    const info = await sharp(contenuto).metadata()
    if (!info.width || !info.height) break
    const larghezza = Math.max(1, Math.round(info.width * scala))
    corrente = await sharp(contenuto).resize({ width: larghezza }).png().toBuffer()
    scala *= 0.8
  }

  return corrente
}

function ricomprimiOk(contenuto: Buffer, massimoByte: number): boolean {
  return contenuto.byteLength <= massimoByte
}

function sostituisciEstensione(nomeFile: string, estensione: string): string {
  const senzaEstensione = nomeFile.replace(/\.[^.]+$/, '')
  return `${senzaEstensione}.${estensione}`
}
