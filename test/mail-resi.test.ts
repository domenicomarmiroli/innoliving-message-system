import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'

import { analizza } from '../src/connectors/mail/parse.js'
import { estraiDatiReso, formattaReso } from '../src/connectors/mail/resi.js'

/**
 * A differenza delle altre fixture di test/fixtures/mail, questa NON è
 * sintetica: è l'email reale di Amazon per l'ordine 403-1049451-9270721
 * (headers ricostruiti, CSS rimosso — vedi il file stesso), l'unico modo
 * di sapere come è fatta davvero una notifica di autorizzazione del reso.
 */

const eml = (nome: string) => readFileSync(`test/fixtures/mail/${nome}`)

describe('estrazione dei dati di reso su un esemplare reale', () => {
  it('legge i campi riassuntivi', async () => {
    const email = await analizza(eml('amazon-richiesta-reso-reale.eml'), 300)
    const dati = estraiDatiReso(email.body_html)

    expect(dati.data_richiesta).toBe('2026-08-24')
    expect(dati.verifica_politiche).toBe('Reso previsto dalle politiche')
    expect(dati.autorizzazione).toBe('Autorizzato automaticamente da Amazon')
  })

  it('legge la riga dell articolo dalla tabella', async () => {
    const email = await analizza(eml('amazon-richiesta-reso-reale.eml'), 301)
    const dati = estraiDatiReso(email.body_html)

    expect(dati.righe).toHaveLength(1)
    expect(dati.righe[0]).toEqual({
      prodotto: 'Innoliving Ferro Da Stiro Carica Continua 1,1lt 2250w Inn-681',
      asin: 'B0CF2SK1VM',
      sku: 'INN-681IS',
      quantita: '1',
      motivo: 'Prestazioni o qualità non adeguate',
      commento: "Prestazioni o qualità non adeguate. Durante l'uso perde acqua.",
    })
  })

  it('legge corriere e tracking della spedizione di reso', async () => {
    const email = await analizza(eml('amazon-richiesta-reso-reale.eml'), 302)
    const dati = estraiDatiReso(email.body_html)

    expect(dati.corriere_reso).toBe('POSTE_ITALIANE')
    expect(dati.tracking_reso).toBe('1UW1URV235536')
  })

  it('un html assente non fa esplodere niente: campi tutti vuoti', () => {
    const dati = estraiDatiReso(null)
    expect(dati.righe).toEqual([])
    expect(dati.corriere_reso).toBeNull()
  })

  it('una tabella diversa da quella attesa produce un elenco vuoto, non un eccezione', () => {
    const dati = estraiDatiReso('<html><body>niente di riconoscibile qui</body></html>')
    expect(dati.righe).toEqual([])
    expect(dati.data_richiesta).toBeNull()
  })
})

describe('formattazione del riassunto', () => {
  it('produce un testo leggibile con tutti i dati raccolti', async () => {
    const email = await analizza(eml('amazon-richiesta-reso-reale.eml'), 303)
    const dati = estraiDatiReso(email.body_html)
    const testo = formattaReso('403-1049451-9270721', dati)

    expect(testo).toContain("Richiesta di reso ricevuta da Amazon per l'ordine 403-1049451-9270721.")
    expect(testo).toContain('Autorizzazione: Autorizzato automaticamente da Amazon')
    expect(testo).toContain('Innoliving Ferro Da Stiro Carica Continua 1,1lt 2250w Inn-681')
    expect(testo).toContain("Commento del cliente: Prestazioni o qualità non adeguate. Durante l'uso perde acqua.")
    expect(testo).toContain('Spedizione di reso: POSTE_ITALIANE, tracking 1UW1URV235536')
  })

  it('senza corriere o tracking non aggiunge una riga vuota di spedizione', () => {
    const testo = formattaReso('111-1111111-1111111', {
      data_richiesta: null, verifica_politiche: null, autorizzazione: null,
      righe: [], corriere_reso: null, tracking_reso: null,
    })
    expect(testo).not.toContain('Spedizione di reso')
  })
})
