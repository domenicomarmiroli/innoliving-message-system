import { readFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import fontkit from '@pdf-lib/fontkit'
import { PDFDocument, rgb, type PDFFont, type PDFPage, type RGB } from 'pdf-lib'
import QRCode from 'qrcode'

/**
 * Foglio di reso per il cliente: istruzioni, QR dei punti BRT, rimborso,
 * contatti e, in basso, l'etichetta BRT con la tipologia in evidenza.
 * La tipologia serve alla logistica per riconoscere il pacco all'arrivo,
 * per questo sta in un riquadro grande subito sopra l'etichetta, la parte
 * del foglio che resta sicuramente visibile sul pacco.
 *
 * Il font è incorporato solo per i caratteri usati (subset): il foglio
 * resta intorno ai 100 KB, lontano dal limite di Microsoft sugli allegati.
 */

export const TIPI_RESO = ['recesso', 'danneggiato', 'verificare'] as const
export type TipoReso = (typeof TIPI_RESO)[number]

export const ETICHETTA_TIPO: Record<TipoReso, string> = {
  recesso: 'RECESSO PRODOTTO NUOVO',
  danneggiato: 'PRODOTTO DANNEGGIATO',
  verificare: 'VERIFICARE PRODOTTO',
}

export interface TestiFoglio {
  email_assistenza: string
  url_punti_ritiro: string
  costo_reso_recesso: string
}

const hex = (h: string): RGB => rgb(parseInt(h.slice(0, 2), 16) / 255, parseInt(h.slice(2, 4), 16) / 255, parseInt(h.slice(4, 6), 16) / 255)
const VERDE = hex('0B6B53')
const SCURO = hex('064033')
const SALVIA = hex('E8F3ED')
const FREDDO = hex('F6F7F8')
const BORDO = hex('E0E4E7')
const T1 = hex('111827')
const T2 = hex('4B5563')
const T3 = hex('6B7280')
const BIANCO = rgb(1, 1, 1)

const W = 595.28
const H = 841.89
const M = 48

const richiedi = createRequire(import.meta.url)
const percorsoFont = (peso: number) => richiedi.resolve(`@fontsource/montserrat/files/montserrat-latin-${peso}-normal.woff`)
const percorsoLogo = new URL('../../../assets/reso/logo.png', import.meta.url)

let risorse: Promise<{ regular: Uint8Array; bold: Uint8Array; logo: Uint8Array }> | null = null
function caricaRisorse() {
  risorse ??= Promise.all([readFile(percorsoFont(400)), readFile(percorsoFont(700)), readFile(percorsoLogo)]).then(
    ([regular, bold, logo]) => ({ regular, bold, logo }),
  )
  return risorse
}

/** Spezza un testo in righe che stanno in `larghezza` punti. */
export function aCapo(testo: string, font: PDFFont, dimensione: number, larghezza: number): string[] {
  const righe: string[] = []
  let riga = ''
  for (const parola of testo.split(/\s+/).filter(Boolean)) {
    const prova = riga ? `${riga} ${parola}` : parola
    if (riga && font.widthOfTextAtSize(prova, dimensione) > larghezza) {
      righe.push(riga)
      riga = parola
    } else riga = prova
  }
  if (riga) righe.push(riga)
  return righe
}

export async function componiFoglioReso(opts: { tipo: TipoReso; etichettaBrt: Buffer | Uint8Array; testi: TestiFoglio }): Promise<Buffer> {
  const { tipo, testi } = opts
  const recesso = tipo === 'recesso'
  const r = await caricaRisorse()

  const doc = await PDFDocument.create()
  doc.registerFontkit(fontkit)
  doc.setTitle(`Reso - ${ETICHETTA_TIPO[tipo]}`)
  const reg = await doc.embedFont(r.regular, { subset: true })
  const bold = await doc.embedFont(r.bold, { subset: true })
  const p = doc.addPage([W, H])

  // Coordinate dall'alto, come si legge la pagina: pdf-lib le vuole dal basso.
  const testo = (s: string, x: number, top: number, size: number, opz: { font?: PDFFont; color?: RGB; larghezza?: number; allinea?: 'sx' | 'centro' | 'dx' } = {}) => {
    const font = opz.font ?? reg
    const larghezza = opz.larghezza ?? W - M - x
    const righe = aCapo(s, font, size, larghezza)
    righe.forEach((riga, i) => {
      const w = font.widthOfTextAtSize(riga, size)
      const dx = opz.allinea === 'centro' ? (larghezza - w) / 2 : opz.allinea === 'dx' ? larghezza - w : 0
      p.drawText(riga, { x: x + dx, y: H - top - size - i * size * 1.35, size, font, color: opz.color ?? T1 })
    })
    return top + righe.length * size * 1.35
  }
  const rett = (pg: PDFPage, x: number, top: number, w: number, h: number, o: { fill?: RGB; bordo?: RGB; spessore?: number }) =>
    pg.drawRectangle({ x, y: H - top - h, width: w, height: h, color: o.fill, borderColor: o.bordo, borderWidth: o.bordo ? (o.spessore ?? 1) : 0 })

  // Testata
  const logo = await doc.embedPng(r.logo)
  const lw = 160
  p.drawImage(logo, { x: M, y: H - 34 - (lw * logo.height) / logo.width, width: lw, height: (lw * logo.height) / logo.width })
  testo('ISTRUZIONI PER IL RESO', W - M - 200, 54, 8, { font: bold, color: VERDE, larghezza: 200, allinea: 'dx' })

  testo('Il tuo reso in quattro passi.', M, 106, 22, { font: bold })
  testo(
    recesso ? "Consegna il pacco in un punto di ritiro BRT con l'etichetta qui sotto." : 'La spedizione è gratuita: ti basta un punto di ritiro BRT.',
    M, 142, 10.5, { color: T2 },
  )

  // Passi
  const passi = [
    'Imballa con cura il prodotto, se possibile nella confezione originale e con tutti gli accessori.',
    "Stampa questo foglio e attaccalo per intero all'esterno del pacco, con l'etichetta ben visibile.",
    'Porta il pacco in un punto di ritiro BRT e consegnalo.',
    'Conserva la ricevuta del punto BRT fino al rimborso.',
  ]
  let y = 176
  passi.forEach((s, i) => {
    p.drawCircle({ x: M + 11, y: H - y - 9, size: 11, borderColor: VERDE, borderWidth: 1.4 })
    const n = String(i + 1)
    p.drawText(n, { x: M + 11 - bold.widthOfTextAtSize(n, 10) / 2, y: H - y - 12.5, size: 10, font: bold, color: VERDE })
    testo(s, M + 34, y + 1, 10, { larghezza: W - 2 * M - 34 - 160 })
    y += 38
  })

  // QR dei punti di ritiro, in una scheda
  const cx = W - M - 140
  rett(p, cx, 170, 140, 170, { fill: FREDDO })
  const qr = QRCode.create(testi.url_punti_ritiro, { errorCorrectionLevel: 'M' })
  const n = qr.modules.size
  const lato = 90 / n
  for (let rr = 0; rr < n; rr++)
    for (let cc = 0; cc < n; cc++)
      if (qr.modules.get(rr, cc)) p.drawRectangle({ x: cx + 25 + cc * lato, y: H - 182 - (rr + 1) * lato, width: lato + 0.05, height: lato + 0.05, color: SCURO })
  testo('Trova il punto BRT', cx + 10, 280, 10, { font: bold, larghezza: 120, allinea: 'centro' })
  testo('Inquadra il codice per vedere i punti di ritiro vicino a te.', cx + 10, 296, 8, { color: T2, larghezza: 120, allinea: 'centro' })

  // Rimborso
  y = 362
  const hBox = recesso ? 78 : 62
  rett(p, M, y, W - 2 * M, hBox, { fill: SALVIA })
  testo('Rimborso entro 14 giorni.', M + 16, y + 11, 12, { font: bold, color: VERDE, larghezza: W - 2 * M - 32 })
  testo(
    recesso
      ? `Emettiamo il rimborso entro 14 giorni da quando il prodotto arriva nel nostro magazzino. Dal rimborso tratteniamo € ${testi.costo_reso_recesso} per la spedizione del reso.`
      : 'Emettiamo il rimborso entro 14 giorni da quando il prodotto arriva nel nostro magazzino.',
    M + 16, y + 32, 10, { color: T2, larghezza: W - 2 * M - 32 },
  )
  y += hBox + 14
  // Su un prodotto danneggiato sappiamo già che non torna integro: l'avviso sul reso non conforme non va.
  if (tipo !== 'danneggiato') {
    y = testo(
      'Rendi il prodotto completo e integro: se il reso non fosse conforme potremmo addebitarti le spese sostenute. I termini completi sono sul sito da cui hai acquistato.',
      M, y, 8, { color: T3 },
    ) + 12
  }
  testo('Ti manca solo un pezzo?', M, y, 10.5, { font: bold, larghezza: W - 2 * M - 200 })
  testo('Scrivici prima di spedire: spesso possiamo mandartelo senza che tu debba rendere il prodotto.', M, y + 17, 9.5, { color: T2, larghezza: W - 2 * M - 200 })
  testo('Assistenza', W - M - 190, y, 10.5, { font: bold, larghezza: 190, allinea: 'dx' })
  testo(testi.email_assistenza, W - M - 190, y + 17, 11, { font: bold, color: VERDE, larghezza: 190, allinea: 'dx' })
  y += 58
  p.drawLine({ start: { x: M, y: H - y }, end: { x: W - M, y: H - y }, color: BORDO, thickness: 1, dashArray: [4, 3] })

  // Tipologia per la logistica
  rett(p, M, y + 12, W - 2 * M, 38, { bordo: T1, spessore: 2.5 })
  testo(ETICHETTA_TIPO[tipo], M, y + 21, 19, { font: bold, larghezza: W - 2 * M, allinea: 'centro' })
  y += 60

  // Etichetta BRT, scalata nello spazio che resta sopra la fascia finale
  const brt = await PDFDocument.load(opts.etichettaBrt)
  const [pagina] = await doc.embedPdf(brt, [0])
  if (!pagina) throw new Error("il PDF dell'etichetta BRT non ha pagine")
  const spazioH = H - 44 - 12 - y
  const scala = Math.min(spazioH / pagina.height, (W - 2 * M) / pagina.width)
  const lw2 = pagina.width * scala
  const lh2 = pagina.height * scala
  p.drawPage(pagina, { x: (W - lw2) / 2, y: H - y - lh2, width: lw2, height: lh2 })

  // Fascia finale
  rett(p, 0, H - 44, W, 44, { fill: SCURO })
  testo("Attacca tutto il foglio all'esterno del pacco.", 0, H - 30, 12, { font: bold, color: BIANCO, larghezza: W, allinea: 'centro' })

  return Buffer.from(await doc.save())
}
