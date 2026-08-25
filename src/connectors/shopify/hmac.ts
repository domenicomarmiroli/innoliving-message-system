import { createHmac, timingSafeEqual } from 'node:crypto'

/**
 * Verifica della firma dei webhook Shopify.
 *
 * Shopify firma il corpo GREZZO con HMAC-SHA256 e la chiave condivisa, e lo
 * spedisce in base64 nell'intestazione X-Shopify-Hmac-Sha256. Va verificato
 * sul corpo esatto ricevuto: se il corpo viene analizzato e riserializzato
 * prima del confronto, la firma non torna mai.
 *
 * Il confronto è a tempo costante: un confronto normale fra stringhe rivela
 * quanti caratteri iniziali coincidono, e su un endpoint pubblico è
 * sufficiente per ricostruire la firma un carattere alla volta.
 */
export function verificaFirma(corpoGrezzo: Buffer, firma: string | undefined, segreto: string): boolean {
  if (!firma) return false

  const atteso = createHmac('sha256', segreto).update(corpoGrezzo).digest()
  let ricevuto: Buffer
  try {
    ricevuto = Buffer.from(firma, 'base64')
  } catch {
    return false
  }
  if (ricevuto.length !== atteso.length) return false
  return timingSafeEqual(ricevuto, atteso)
}
