import { describe, it, expect } from 'vitest'
import { aggiornamentiDaSpedizioni, linkTracciamento, statoDaZoho, type SpedizioneZoho } from '../src/connectors/magazzino/spedizioni.js'

const sped = (s: Partial<SpedizioneZoho>): SpedizioneZoho => ({
  salesorder_number: null,
  package_number: null,
  carrier: null,
  tracking_number: null,
  shipment_date: null,
  status: null,
  ...s,
})

describe('aggiornamentiDaSpedizioni', () => {
  it('dal pacchetto Zoho AMZS al numero Amazon, con il link BRT', () => {
    const [a, ...resto] = aggiornamentiDaSpedizioni([
      sped({ salesorder_number: 'AMZS407-9796715-9517915', carrier: 'BRT', tracking_number: '066061651672', shipment_date: '2026-10-05', status: 'delivered' }),
    ])
    expect(resto).toHaveLength(0)
    expect(a).toEqual({
      numero_ordine: '407-9796715-9517915',
      tracking_number: '066061651672',
      carrier: 'BRT',
      tracking_url: 'https://vas.brt.it/vas/sped_det_show.hsm?referer=sped_numspe_par.htm&Nspediz=066061651672',
      stato: 'consegnato',
      data_spedizione: '2026-10-05',
    })
  })

  it('scarta ciò che non è un ordine Amazon o non ha tracking', () => {
    expect(
      aggiornamentiDaSpedizioni([
        sped({ salesorder_number: 'A-1234', carrier: 'BRT', tracking_number: '066000000001' }),
        sped({ salesorder_number: 'TTOK5778', carrier: 'BRT', tracking_number: '066000000002' }),
        sped({ salesorder_number: 'AMZS407-9796715-9517915', carrier: 'BRT', tracking_number: '  ' }),
      ]),
    ).toEqual([])
  })

  it('più pacchetti per lo stesso ordine: vince il più recente', () => {
    const esito = aggiornamentiDaSpedizioni([
      sped({ salesorder_number: 'AMZS403-9605030-2189100', carrier: 'BRT', tracking_number: '066000000009', shipment_date: '2026-10-05' }),
      sped({ salesorder_number: 'AMZS403-9605030-2189100', carrier: 'BRT', tracking_number: '066000000001', shipment_date: '2026-09-20' }),
    ])
    expect(esito.map((a) => a.tracking_number)).toEqual(['066000000009'])
  })
})

describe('linkTracciamento', () => {
  it('nessun link per un corriere che non conosciamo', () => {
    expect(linkTracciamento('Corriere Ignoto', '123')).toBeNull()
    expect(linkTracciamento(null, '123')).toBeNull()
  })
})

describe('statoDaZoho', () => {
  it('i tre valori visti su Zoho, e null per un valore nuovo', () => {
    expect(statoDaZoho('not_shipped')).toBe('non_spedito')
    expect(statoDaZoho('shipped')).toBe('spedito')
    expect(statoDaZoho('delivered')).toBe('consegnato')
    expect(statoDaZoho('returned')).toBeNull()
  })
})
