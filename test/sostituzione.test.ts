import { describe, expect, it } from 'vitest'
import {
  CONFIG_PREDEFINITA,
  codiceProdottoDaTicket,
  codiceSconto,
  indirizzoCompleto,
  inputOrdine,
  inputSconto,
  scegliVariante,
  skuNegozio,
  valoreDaGaranzia,
  type VarianteNegozio,
} from '../src/core/sostituzione.js'

const variante = (sku: string, extra: Partial<VarianteNegozio> = {}): VarianteNegozio => ({
  variant_gid: `gid://shopify/ProductVariant/${sku}`,
  sku,
  titolo: 'Bollitore',
  prezzo: '23.90',
  disponibili: 903,
  vendibile: true,
  stato_prodotto: 'ACTIVE',
  ...extra,
})

const indirizzo = {
  nome: 'Mario', cognome: 'Rossi', indirizzo: 'Via Roma 1', cap: '20100', citta: 'Milano', provincia: 'MI', paese: 'IT',
}

describe('sostitutivo in garanzia', () => {
  it('aggiunge il suffisso del negozio una volta sola', () => {
    expect(skuNegozio('inn-732', 'IS')).toBe('INN-732IS')
    expect(skuNegozio('INN-732IS', 'IS')).toBe('INN-732IS')
  })

  it('trova il codice: dati del portale, poi testo, poi oggetto', () => {
    expect(codiceProdottoDaTicket([{ raw: { garanzia: { codice_modello: 'inn-732' } }, testo: null }], null)).toBe('INN-732')
    expect(codiceProdottoDaTicket([{ raw: {}, testo: 'Prodotto: BOLLITORE\nCodice: INN-732\nData' }], null)).toBe('INN-732')
    expect(codiceProdottoDaTicket([], 'Riparazione in garanzia — BOLLITORE ELETTRICO CORDLESS INN-732')).toBe('INN-732')
    expect(codiceProdottoDaTicket([], 'Ciao')).toBeNull()
  })

  it('sceglie solo lo SKU esatto, non la seconda scelta', () => {
    const r = scegliVariante([variante('INN-732IS'), variante('INN-732SR', { disponibili: 0, vendibile: false })], 'INN-732IS')
    expect(r.esito).toBe('trovata')
    expect(r.esito === 'trovata' && r.disponibile).toBe(true)
  })

  it('esaurito o in bozza = non disponibile; doppioni = ambiguo; assente = non trovato', () => {
    const esaurito = scegliVariante([variante('INN-1IS', { disponibili: 0 })], 'INN-1IS')
    expect(esaurito.esito === 'trovata' && esaurito.disponibile).toBe(false)
    const bozza = scegliVariante([variante('INN-1IS', { stato_prodotto: 'DRAFT' })], 'INN-1IS')
    expect(bozza.esito === 'trovata' && bozza.disponibile).toBe(false)
    expect(scegliVariante([variante('INN-1IS'), variante('INN-1IS')], 'INN-1IS').esito).toBe('ambigua')
    expect(scegliVariante([variante('INN-1ISX')], 'INN-1IS').esito).toBe('non_trovata')
  })

  it('valore dello scontrino: solo numeri positivi, arrotondato al centesimo', () => {
    expect(valoreDaGaranzia({ valore_prodotto: 23.899 })).toBe(23.9)
    expect(valoreDaGaranzia({ valore_prodotto: 0 })).toBeNull()
    expect(valoreDaGaranzia(null)).toBeNull()
  })

  it("indirizzo del portale: buono solo se completo, paese predefinito IT", () => {
    expect(indirizzoCompleto({ ...indirizzo, paese: null })?.paese).toBe('IT')
    expect(indirizzoCompleto({ nome: 'Mario', cap: '20100' })).toBeNull()
    expect(indirizzoCompleto(null)).toBeNull()
  })

  it("l'ordine è a 0 euro, pagato, con il ticket nel tag e nella nota", () => {
    const { order, options } = inputOrdine({
      numero_ticket: '16300', variant_gid: 'gid://x/1', email: 'a@b.it',
      indirizzo: { ...indirizzo, presso: null, indirizzo2: null, telefono: null }, conf: CONFIG_PREDEFINITA,
    })
    const riga = (order['lineItems'] as Record<string, any>[])[0]!
    expect(riga['priceSet'].shopMoney.amount).toBe('0.00')
    expect(riga['requiresShipping']).toBe(true)
    expect((order['shippingLines'] as Record<string, any>[])[0]!['priceSet'].shopMoney.amount).toBe('0.00')
    expect(order['financialStatus']).toBe('PAID')
    expect(order['taxesIncluded']).toBe(true)
    expect(order['tags']).toEqual(['sostituzione-garanzia', 'ticket-16300'])
    expect(String(order['note'])).toContain('16300')
    expect(options['inventoryBehaviour']).toBe('DECREMENT_OBEYING_POLICY')
  })

  it('codice sconto: leggibile, monouso, importo fisso, con scadenza', () => {
    const codice = codiceSconto('garanzia', '16300', () => 0)
    expect(codice).toBe('GARANZIA-16300-AAAA')
    const inizio = new Date('2026-11-25T10:00:00Z')
    const { basicCodeDiscount, scade_il } = inputSconto({ codice, numero_ticket: '16300', importo: 23.9, inizio, conf: CONFIG_PREDEFINITA })
    expect(basicCodeDiscount['usageLimit']).toBe(1)
    expect((basicCodeDiscount['customerGets'] as any).value.discountAmount.amount).toBe('23.90')
    expect(scade_il.toISOString()).toBe('2027-02-23T10:00:00.000Z')
  })
})

describe('indirizzo proposto nel riquadro', async () => {
  const { indirizzoDaRitiro } = await import('../src/core/sostituzione.js')
  const { sceltaIndirizzo } = await import('../src/connectors/shopify/sostituzione.js')

  it('ticket vecchio: nome, cognome, CAP e provincia dal testo di ritiro', () => {
    const a = indirizzoDaRitiro('Mario Luigi Rossi', 'via delle rose 12/f san pietro 40018 (BO)', '333')
    expect(a).toMatchObject({ nome: 'Mario Luigi', cognome: 'Rossi', cap: '40018', provincia: 'BO', paese: 'IT', telefono: '333' })
    expect(a?.indirizzo).toBe('via delle rose 12/f san pietro 40018 (BO)')
    expect(indirizzoDaRitiro('Anna', 'Chiaramonti SS, Via Budroni 12', null)).toMatchObject({ nome: 'Anna', cognome: null, provincia: 'SS', cap: null })
    expect(indirizzoDaRitiro(null, null, null)).toBeNull()
  })

  it('vince quello salvato, poi il portale, poi il ritiro', () => {
    const vuoto = { indirizzo_salvato: null, indirizzo_ultimo_ordine: null, indirizzo_portale: null, intestatario: null, indirizzo_ritiro: null, telefono: null }
    expect(sceltaIndirizzo(vuoto)).toEqual({ indirizzo: null, fonte: null })
    expect(sceltaIndirizzo({ ...vuoto, intestatario: 'A B', indirizzo_ritiro: 'Via X 1' }).fonte).toBe('ritiro')
    expect(sceltaIndirizzo({ ...vuoto, indirizzo_portale: { cap: '1' }, indirizzo_ritiro: 'Via X 1' }).fonte).toBe('portale')
    expect(sceltaIndirizzo({ ...vuoto, indirizzo_salvato: { cap: '2' }, indirizzo_portale: { cap: '1' } })).toEqual({ indirizzo: { cap: '2' }, fonte: 'salvato' })
  })
})
