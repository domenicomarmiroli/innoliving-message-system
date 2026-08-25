import type { Db } from '../../db/index.js'
import type { Logger } from '../../logger.js'
import type { OrdineCanonico } from './normalize.js'

/**
 * Scrittura idempotente degli ordini.
 *
 * Il vincolo unique (channel, external_order_id) è la difesa vera: questa
 * funzione può essere rieseguita all'infinito sullo stesso ordine senza
 * duplicare nulla.
 *
 * Il caso spinoso è noto e reale: nello store esistono ordini Amazon con lo
 * stesso numero ma shopify_gid diverso (AMZ304-0904527-7250707 compare due
 * volte, 27 e 30 luglio). Non li sovrascriviamo in silenzio: teniamo il più
 * recente per data d'ordine e registriamo lo scarto in ingest_anomaly, così
 * qualcuno può guardarci dentro.
 */

export type EsitoUpsert = 'inserito' | 'aggiornato' | 'ignorato_piu_vecchio'

export interface RisultatoUpsert {
  esito: EsitoUpsert
  order_id: string | null
  anomalia: boolean
}

export async function upsertOrdine(
  db: Db,
  log: Logger,
  o: OrdineCanonico,
): Promise<RisultatoUpsert> {
  return db.begin(async (tx) => {
    const [esistente] = await tx<
      { id: string; shopify_gid: string | null; placed_at: string | null }[]
    >`
      select id, shopify_gid, placed_at
      from "order"
      where channel = ${o.channel} and external_order_id = ${o.external_order_id}
      for update
    `

    // Duplicato: stesso numero d'ordine, ordine Shopify diverso.
    if (esistente && o.shopify_gid && esistente.shopify_gid && esistente.shopify_gid !== o.shopify_gid) {
      const esistentePiuRecente =
        (esistente.placed_at ?? '') >= (o.placed_at ?? '')

      await tx`
        insert into ingest_anomaly (tipo, payload)
        values ('ordine_duplicato', ${tx.json({
          channel: o.channel,
          external_order_id: o.external_order_id,
          gid_in_archivio: esistente.shopify_gid,
          gid_in_arrivo: o.shopify_gid,
          tenuto: esistentePiuRecente ? esistente.shopify_gid : o.shopify_gid,
        })})
      `
      log.warn(
        { channel: o.channel, ordine: o.external_order_id },
        'ordine duplicato: due shopify_gid per lo stesso numero',
      )

      if (esistentePiuRecente) {
        return { esito: 'ignorato_piu_vecchio', order_id: esistente.id, anomalia: true }
      }
    }

    const [riga] = await tx<{ id: string }[]>`
      insert into "order" (
        channel, external_order_id, shopify_gid, shopify_name, operator, buyer_alias,
        placed_at, financial_status, fulfillment_status,
        tracking_number, tracking_url, carrier, total, currency, raw
      ) values (
        ${o.channel}, ${o.external_order_id}, ${o.shopify_gid}, ${o.shopify_name},
        ${o.operator}, ${o.buyer_alias}, ${o.placed_at}, ${o.financial_status},
        ${o.fulfillment_status}, ${o.tracking_number}, ${o.tracking_url}, ${o.carrier},
        ${o.total}, ${o.currency}, ${tx.json(o.raw as never)}
      )
      on conflict (channel, external_order_id) do update set
        shopify_gid        = excluded.shopify_gid,
        shopify_name       = excluded.shopify_name,
        operator           = excluded.operator,
        -- non azzerare un alias già noto con un valore vuoto
        buyer_alias        = coalesce(excluded.buyer_alias, "order".buyer_alias),
        placed_at          = excluded.placed_at,
        financial_status   = excluded.financial_status,
        fulfillment_status = excluded.fulfillment_status,
        tracking_number    = coalesce(excluded.tracking_number, "order".tracking_number),
        tracking_url       = coalesce(excluded.tracking_url, "order".tracking_url),
        carrier            = coalesce(excluded.carrier, "order".carrier),
        total              = excluded.total,
        currency           = excluded.currency,
        raw                = excluded.raw,
        updated_at         = now()
      returning id
    `

    const orderId = riga?.id ?? null
    if (!orderId) return { esito: 'inserito', order_id: null, anomalia: false }

    // Righe: si riscrivono per intero. Sono poche e non hanno vita propria,
    // quindi sostituirle è più semplice e più corretto che riconciliarle.
    // Il webhook non porta le immagini: le conserviamo se già presenti.
    if (o.righe.length > 0) {
      const immaginiNote = await tx<{ sku: string | null; image_url: string | null }[]>`
        select sku, image_url from order_line
        where order_id = ${orderId} and image_url is not null
      `
      const perSku = new Map(immaginiNote.map((r) => [r.sku, r.image_url]))

      await tx`delete from order_line where order_id = ${orderId}`
      for (const r of o.righe) {
        await tx`
          insert into order_line (order_id, sku, titolo, quantita, prezzo, image_url, raw)
          values (${orderId}, ${r.sku}, ${r.titolo}, ${r.quantita}, ${r.prezzo},
                  ${r.image_url ?? perSku.get(r.sku) ?? null}, ${tx.json(r.raw as never)})
        `
      }
    }

    return { esito: esistente ? 'aggiornato' : 'inserito', order_id: orderId, anomalia: false }
  })
}
