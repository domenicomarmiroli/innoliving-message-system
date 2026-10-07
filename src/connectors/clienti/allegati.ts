import { createHash } from 'node:crypto'
import { z } from 'zod'

import type { Config } from '../../config.js'
import type { Logger } from '../../logger.js'
import { caricaAllegato, storageConfigurato } from '../../core/storage.js'
import { dimensioniImmagine } from '../../core/immagine.js'
import { mimeMigliore } from '../../core/mime.js'

/**
 * Allegati mandati dal cliente dai siti: foto in chat all'apertura del
 * ticket, file aggiunti dall'area cliente.
 *
 * Arrivano in base64 dentro il JSON della chiamata server-to-server del
 * sito. Si accettano solo i formati che servono all'assistenza (foto di un
 * prodotto o di un pacco, uno scontrino, un video breve) e con limiti di
 * dimensione: è un input che viene da internet, non da un marketplace.
 */

export const MASSIMO_ALLEGATI = 5
export const MASSIMO_BYTE_FILE = 10 * 1024 * 1024
export const MASSIMO_BYTE_TOTALE = 20 * 1024 * 1024
/** Corpo della richiesta: totale in base64 (+33%) più il testo. */
export const LIMITE_CORPO_RICHIESTA = 30 * 1024 * 1024

const TIPI_AMMESSI = new Set([
  'image/jpeg',
  'image/png',
  'image/webp',
  'image/heic',
  'image/heif',
  'application/pdf',
  'video/mp4',
  'video/quicktime',
])

export const schemaAllegato = z.object({
  nome_file: z.string().trim().min(1).max(200),
  mime: z.string().trim().max(100).optional(),
  contenuto_base64: z.string().min(1),
})
export type AllegatoInviato = z.infer<typeof schemaAllegato>

export interface FileCliente {
  nome_file: string
  mime: string
  contenuto: Buffer
}

/**
 * Controlla e decodifica. Lancia con un messaggio da mostrare al cliente:
 * meglio un rifiuto chiaro che un file perso in silenzio.
 */
export function validaAllegati(allegati: AllegatoInviato[]): FileCliente[] {
  if (allegati.length > MASSIMO_ALLEGATI) {
    throw new Error(`Puoi allegare al massimo ${MASSIMO_ALLEGATI} file.`)
  }
  let totale = 0
  return allegati.map((a) => {
    const nome = a.nome_file.replace(/[/\\]/g, '_')
    const mime = mimeMigliore(a.mime ?? null, nome)
    if (!mime || !TIPI_AMMESSI.has(mime)) {
      throw new Error(`Il file «${nome}» non è di un tipo accettato (foto, PDF o video).`)
    }
    const contenuto = Buffer.from(a.contenuto_base64, 'base64')
    if (contenuto.byteLength === 0) throw new Error(`Il file «${nome}» è vuoto.`)
    if (contenuto.byteLength > MASSIMO_BYTE_FILE) {
      throw new Error(`Il file «${nome}» supera i ${MASSIMO_BYTE_FILE / 1024 / 1024} MB.`)
    }
    totale += contenuto.byteLength
    if (totale > MASSIMO_BYTE_TOTALE) {
      throw new Error(`Gli allegati superano in tutto i ${MASSIMO_BYTE_TOTALE / 1024 / 1024} MB.`)
    }
    return { nome_file: nome, mime, contenuto }
  })
}

export interface AllegatoPronto {
  nome_file: string
  mime: string
  dimensione_byte: number
  checksum: string
  storage_path: string | null
  larghezza: number | null
  altezza: number | null
}

/**
 * Su Storage PRIMA della transazione (I/O di rete), con lo stesso percorso
 * degli allegati email: `{account}/{checksum}-{nome}`. Senza Storage
 * l'allegato entra come solo metadato, mai un messaggio perso per questo.
 */
export async function preparaAllegatiCliente(
  config: Config,
  log: Logger,
  accountCode: string,
  files: FileCliente[],
): Promise<AllegatoPronto[]> {
  return Promise.all(
    files.map(async (f) => {
      const checksum = createHash('sha256').update(f.contenuto).digest('hex')
      const dimensioni = await dimensioniImmagine(f.contenuto)
      let storage_path: string | null = null
      if (storageConfigurato(config)) {
        try {
          storage_path = await caricaAllegato(config, `${accountCode}/${checksum}-${f.nome_file}`, f.contenuto, f.mime)
        } catch (errore) {
          log.error(
            { err: errore instanceof Error ? errore.message : String(errore), nome_file: f.nome_file },
            'upload su Storage di un allegato del cliente fallito: registrato solo il metadato',
          )
        }
      }
      return {
        nome_file: f.nome_file,
        mime: f.mime,
        dimensione_byte: f.contenuto.byteLength,
        checksum,
        storage_path,
        larghezza: dimensioni?.larghezza ?? null,
        altezza: dimensioni?.altezza ?? null,
      }
    }),
  )
}
