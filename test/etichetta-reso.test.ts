import { readFileSync, writeFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { PDFDocument } from 'pdf-lib'

import { configBrtResi, costruisciRichiesta, interpretaRisposta } from '../src/connectors/brt/reso.js'
import { componiFoglioReso, TIPI_RESO } from '../src/core/reso/foglio.js'
import { numeroOrdineVendita, riferimentoBrt } from '../src/connectors/reso/etichetta.js'

// Risposta reale dell'ambiente di collaudo BRT (dal worker che faceva questo prima).
const collaudo = JSON.parse(readFileSync('test/fixtures/brt/reso-risposta-collaudo.json', 'utf8'))

const conf = configBrtResi.parse({
  endpoint: 'https://brt.example/rest/v1/shipments/shipment',
  codice_cliente: '1000001',
  filiale_partenza: 100,
  codice_tariffa: '300',
  codice_servizio: 'B15',
  filiale_ritorno: '1000001500',
  peso_kg: 2,
  destinatario: { ragione_sociale: 'Esempio S.p.A.', indirizzo: 'Via Roma 1', cap: '00100', citta: 'Roma', provincia: 'RM', paese: 'IT', email: 'resi@esempio.it', telefono: '+39 06 0000000' },
  foglio: { email_assistenza: 'aiuto@esempio.it', url_punti_ritiro: 'https://punti.example/ritiro', costo_reso_recesso: '6,00' },
  zoho: { modulo: 'cm_ldv_reso', prefisso_amazon: 'AMZS' },
})

describe('richiesta BRT di reso', () => {
  it('il destinatario vero è il magazzino, del cliente c\'è solo il nome', () => {
    const r = costruisciRichiesta(conf, { utente: 'u', password: 'p' }, { nome_cliente: 'Mario Rossi', riferimento: 'T12096-RIFERIMENTO-LUNGO', note: '404-1234567-1234567' })
    expect(r.returnShipmentConsignee.returnShipmentConsigneeZIPCode).toBe('00100')
    expect(r.actualSender.actualSenderName).toBe('Mario Rossi')
    expect(r.actualSender.actualSenderAddress).toBe('')
    expect(r.createData.alphanumericSenderReference).toHaveLength(15)
    expect(r.createData.brtServiceCode).toBe('B15')
    expect(r.isLabelRequired).toBe(1)
  })
})

describe('risposta BRT', () => {
  it('legge segnacollo, tracking e PDF; il raw non contiene i byte', () => {
    const e = interpretaRisposta(collaudo)
    expect(e.ok).toBe(true)
    if (!e.ok) return
    expect(e.parcel_id).toBe('102224270007289104')
    expect(e.tracking_parcel_id).toBe('102224270007289')
    expect(e.pdf.subarray(0, 5).toString()).toBe('%PDF-')
    expect(JSON.stringify(e.raw)).not.toContain('JVBERi0')
  })

  it('un errore BRT diventa un motivo leggibile, non un successo vuoto', () => {
    const e = interpretaRisposta({ createResponse: { executionMessage: { code: -63, severity: 'ERROR', codeDesc: 'WRONG CREDENTIALS', message: 'Login failed' } } })
    expect(e.ok).toBe(false)
    if (!e.ok) expect(e.errore).toContain('WRONG CREDENTIALS')
  })
})

describe('numero ordine di vendita e riferimento', () => {
  it('Amazon: prefisso dalla configurazione + numero Amazon', () => {
    expect(numeroOrdineVendita('amazon', '404-1296441-3120351', 'AMZS')).toBe('AMZS404-1296441-3120351')
  })
  it('altri canali: nessuna ipotesi, si cerca su Zoho', () => {
    expect(numeroOrdineVendita('shopify', '#1087', 'AMZS')).toBeNull()
  })
  it('riferimento in etichetta: numero del ticket', () => {
    expect(riferimentoBrt(12096)).toBe('TICKET 12096')
  })
})

describe('foglio di reso', () => {
  it.each(TIPI_RESO)('compone un PDF A4 leggero per "%s"', async (tipo) => {
    const e = interpretaRisposta(collaudo)
    if (!e.ok) throw new Error('fixture non valida')
    const pdf = await componiFoglioReso({ tipo, etichettaBrt: e.pdf, testi: conf.foglio })
    const letto = await PDFDocument.load(pdf)
    expect(letto.getPageCount()).toBe(1)
    expect(Math.round(letto.getPage(0).getWidth())).toBe(595)
    expect(pdf.length).toBeLessThan(250_000)
    if (process.env.FOGLIO_ANTEPRIMA) writeFileSync(`${process.env.FOGLIO_ANTEPRIMA}/foglio-${tipo}.pdf`, pdf)
  })
})
