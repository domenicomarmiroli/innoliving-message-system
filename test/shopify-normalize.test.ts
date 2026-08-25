import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'

import { daGraphQL, daWebhook } from '../src/connectors/shopify/normalize.js'

const gql = JSON.parse(readFileSync('test/fixtures/shopify/graphql.json', 'utf8'))
const webhookMirakl = JSON.parse(readFileSync('test/fixtures/shopify/webhook-mirakl.json', 'utf8'))

describe('riconoscimento del canale — esemplari reali dello store', () => {
  it('Amazon: estrae il numero dal nome dell ordine', () => {
    const o = daGraphQL(gql.amazon)
    expect(o.channel).toBe('amazon')
    // il nome è AMZ304-0904527-7250707: l'ID è la parte dopo il prefisso
    expect(o.external_order_id).toBe('304-0904527-7250707')
    expect(o.shopify_name).toBe('AMZ304-0904527-7250707')
    expect(o.operator).toBeNull()
  })

  it('Mirakl MediaMarktSaturn: id da sourceIdentifier, operatore e alias acquirente', () => {
    const o = daGraphQL(gql.mirakl_mms)
    expect(o.channel).toBe('mirakl')
    expect(o.external_order_id).toBe('02116_325104572-A')
    expect(o.operator).toBe('MediaMarktSaturn')
    expect(o.buyer_alias).toBe('rk0idlx32ez.fznm52pke@notification.mirakl.net')
    expect(o.righe[0]?.sku).toBe('INN-505NEWIS')
    expect(o.righe[0]?.image_url).toContain('cdn.shopify.com')
  })

  it('Mirakl Leroy Merlin France: stesso connettore, operatore diverso', () => {
    const o = daGraphQL(gql.mirakl_lmfr)
    expect(o.channel).toBe('mirakl')
    expect(o.external_order_id).toBe('005-26192L8770-A')
    expect(o.operator).toBe('Leroy Merlin France')
    expect(o.carrier).toBe('BRT')
    expect(o.tracking_number).toBe('066061400001')
  })

  it('TikTok: id dall attributo TikTok Order Number, non dal nome', () => {
    const o = daGraphQL(gql.tiktok)
    expect(o.channel).toBe('tiktok')
    expect(o.external_order_id).toBe('576940907258812630')
    expect(o.shopify_name).toBe('TTOK576940907258812630')
  })

  it('Sito: caso residuo, id uguale al nome', () => {
    const o = daGraphQL(gql.sito)
    expect(o.channel).toBe('shopify')
    expect(o.external_order_id).toBe('INSH6403')
    expect(o.tracking_url).toContain('brt.it')
  })
})

describe('ordini di servizio', () => {
  it('un ordine con tag RICAMBIO non è una vendita', () => {
    const o = daGraphQL(gql.ricambio)
    expect(o.is_service_order).toBe(true)
    expect(o.total).toBe(0)
  })

  it('un ordine normale non è di servizio', () => {
    expect(daGraphQL(gql.sito).is_service_order).toBe(false)
  })
})

describe('adattatore webhook — forma REST', () => {
  it('riconosce Mirakl con i tag in stringa e note_attributes', () => {
    const o = daWebhook(webhookMirakl)
    expect(o.channel).toBe('mirakl')
    expect(o.external_order_id).toBe('02116_325093736-A')
    expect(o.operator).toBe('MediaMarktSaturn')
    expect(o.buyer_alias).toBe('rceuaxh8dmv.fznm52pke@notification.mirakl.net')
    expect(o.total).toBe(24.9)
  })

  it('webhook e GraphQL producono lo stesso canale per lo stesso ordine', () => {
    // stesso ordine, due forme diverse: il canale non può dipendere dalla forma
    const daRest = daWebhook(webhookMirakl)
    const daGql = daGraphQL(gql.mirakl_mms)
    expect(daRest.channel).toBe(daGql.channel)
  })

  it('lo stato di evasione assente diventa unfulfilled, non null', () => {
    expect(daWebhook(webhookMirakl).fulfillment_status).toBe('unfulfilled')
  })
})

describe('robustezza', () => {
  it('un ordine senza righe non fa saltare la normalizzazione', () => {
    expect(daGraphQL(gql.mirakl_lmfr).righe).toEqual([])
  })

  it('conserva sempre il payload originale', () => {
    expect(daGraphQL(gql.sito).raw).toBe(gql.sito)
  })

  it('un payload minimo non lancia eccezioni', () => {
    const o = daWebhook({ name: 'INSH0001' })
    expect(o.channel).toBe('shopify')
    expect(o.external_order_id).toBe('INSH0001')
    expect(o.righe).toEqual([])
  })
})
