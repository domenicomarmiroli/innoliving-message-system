import { describe, it, expect } from 'vitest'
import { dataIso, leggiRisposta, oraBreve, statoReso, urlTrackingReso } from '../src/connectors/brt/tracking-reso.js'

const evento = (data: string, ora: string, descrizione: string, filiale = 'MILANO (014)') => ({
  evento: { data, ora, descrizione, filiale: { nome: filiale } },
})

describe('urlTrackingReso', () => {
  it("ricava il servizio di tracking dall'endpoint delle spedizioni", () => {
    expect(urlTrackingReso('https://api.brt.it/rest/v1/shipments/shipment', '140140014557075')).toBe(
      'https://api.brt.it/rest/v1/tracking/parcelID/140140014557075',
    )
  })
})

describe('date e ore di BRT', () => {
  it('accetta le forme viste e quelle plausibili', () => {
    expect(dataIso('2026-11-16')).toBe('2026-11-16')
    expect(dataIso('16.11.2026')).toBe('2026-11-16')
    expect(dataIso('16/11/2026')).toBe('2026-11-16')
    expect(dataIso('20261116')).toBe('2026-11-16')
    expect(dataIso('boh')).toBeNull()
    expect(oraBreve('10:15:00')).toBe('10:15')
    expect(oraBreve('9.05')).toBe('09:05')
    expect(oraBreve(undefined)).toBeNull()
  })
})

describe('leggiRisposta', () => {
  it('senza eventi: BRT non ha ancora il pacco, non è un errore', () => {
    expect(leggiRisposta({ bolla: { esito: 0, lista_eventi: [] } })).toEqual({ riconosciuta: true, trovata: false })
    expect(leggiRisposta({ bolla: { esito: -1 } })).toEqual({ riconosciuta: true, trovata: false })
  })

  it('in viaggio: eventi dal più recente, stato in_transito', () => {
    const r = leggiRisposta({
      bolla: {
        esito: 0,
        lista_eventi: [
          evento('2026-11-14', '09:00', 'DATI SPEDIZ. TRASMESSI A BRT'),
          evento('2026-11-17', '18:30', 'PARTITA'),
          evento('2026-11-16', '17:10', 'ARRIVATA IN FILIALE'),
        ],
      },
    })
    if (!r.riconosciuta || !r.trovata) throw new Error('non letta')
    expect(r.eventi.map((e) => e.evento)).toEqual(['PARTITA', 'ARRIVATA IN FILIALE', 'DATI SPEDIZ. TRASMESSI A BRT'])
    expect(r.eventi[0]).toEqual({ data: '2026-11-17', ora: '18:30', filiale: 'MILANO (014)', evento: 'PARTITA' })
    expect(r.stato).toBe('in_transito')
  })

  it('consegnata al magazzino: stato finale', () => {
    const r = leggiRisposta({
      bolla: { lista_eventi: [evento('18.11.2026', '10.20', 'CONSEGNATA'), evento('17.11.2026', '18.30', 'PARTITA')] },
    })
    if (!r.riconosciuta || !r.trovata) throw new Error('non letta')
    expect(r.stato).toBe('consegnato')
    expect(r.eventi[0]).toMatchObject({ data: '2026-11-18', ora: '10:20' })
  })

  it('solo dati trasmessi: spedito (etichetta creata, pacco non ancora ritirato)', () => {
    const r = leggiRisposta({ bolla: { lista_eventi: [evento('2026-11-16', '09:00', 'DATI SPEDIZ. TRASMESSI A BRT')] } })
    if (!r.riconosciuta || !r.trovata) throw new Error('non letta')
    expect(r.stato).toBe('spedito')
  })

  it('forma vista dal vivo (18/11): dentro ttParcelIdResponse, consegna in dati_consegna', () => {
    const r = leggiRisposta({
      ttParcelIdResponse: {
        esito: 0,
        bolla: {
          dati_spedizione: { spedizione_id: '051010453152', spedizione_data: '15.10.2026', filiale_arrivo: 'ANCONA CENTRO' },
          dati_consegna: { data_consegna_merce: '16.10.2026', ora_consegna_merce: '09.16' },
        },
      },
    })
    expect(r).toEqual({
      riconosciuta: true, trovata: true, stato: 'consegnato',
      eventi: [{ data: '2026-10-16', ora: '09:16', filiale: 'ANCONA CENTRO', evento: 'CONSEGNATA' }],
    })
  })

  it('bolla senza eventi né consegna: dati trasmessi, pacco non ancora in viaggio', () => {
    const r = leggiRisposta({
      ttParcelIdResponse: {
        bolla: { dati_spedizione: { spedizione_id: '1', spedizione_data: '15.11.2026' }, dati_consegna: { data_consegna_merce: '' } },
      },
    })
    if (!r.riconosciuta || !r.trovata) throw new Error('non letta')
    expect(r.stato).toBe('spedito')
    expect(r.eventi[0]).toMatchObject({ data: '2026-11-15', evento: 'DATI SPEDIZ. TRASMESSI A BRT' })
  })

  it('una risposta che non somiglia a quella attesa non diventa uno stato inventato', () => {
    expect(leggiRisposta({ errore: 'x' })).toMatchObject({ riconosciuta: false })
    expect(leggiRisposta(null)).toMatchObject({ riconosciuta: false })
    expect(leggiRisposta({ bolla: { lista_eventi: [{ evento: { descrizione: 'PARTITA' } }] } })).toMatchObject({ riconosciuta: false })
  })
})

describe('statoReso', () => {
  it('"reso al mittente" non vale per un reso: il mittente è il cliente', () => {
    expect(statoReso([{ data: '2026-11-17', ora: null, filiale: null, evento: 'RESO MITTENTE' }])).toBe('in_transito')
  })
})
