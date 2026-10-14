import { z } from 'zod'

/**
 * Lettera di vettura di reso via API REST di BRT (`POST /shipments/shipment`).
 *
 * Stessa richiesta del worker esterno che la generava prima (Cloudways),
 * collaudata in produzione da mesi: spedizione "di ritorno" (servizio e
 * filiale di ritorno del contratto) in cui il destinatario vero è il
 * magazzino (`returnShipmentConsignee`). Del cliente basta il nome: il
 * pacco lo porta lui in un punto BRT, non c'è un ritiro a domicilio.
 *
 * BRT risponde con l'etichetta già in PDF (base64) e il segnacollo.
 */

export const configBrtResi = z.object({
  endpoint: z.string().url(),
  codice_cliente: z.string().min(1),
  filiale_partenza: z.coerce.number().int(),
  codice_tariffa: z.string().min(1),
  codice_servizio: z.string().min(1),
  filiale_ritorno: z.string().min(1),
  peso_kg: z.number().positive().default(2),
  destinatario: z.object({
    ragione_sociale: z.string().min(1),
    indirizzo: z.string().min(1),
    cap: z.string().min(1),
    citta: z.string().min(1),
    provincia: z.string().min(1),
    paese: z.string().min(2),
    email: z.string().min(1),
    telefono: z.string().min(1),
  }),
  foglio: z.object({
    email_assistenza: z.string().min(1),
    url_punti_ritiro: z.string().url(),
    costo_reso_recesso: z.string().min(1),
  }),
  zoho: z.object({
    modulo: z.string().min(1),
    prefisso_amazon: z.string().min(1),
  }),
})
export type ConfigBrtResi = z.infer<typeof configBrtResi>

export interface DatiReso {
  /** Nome del cliente, solo per l'etichetta (max 70 caratteri). */
  nome_cliente: string
  /** Riferimento breve stampato in etichetta (max 15 caratteri). */
  riferimento: string
  /** Note in etichetta: il numero d'ordine per esteso. */
  note: string
}

export function costruisciRichiesta(conf: ConfigBrtResi, credenziali: { utente: string; password: string }, dati: DatiReso) {
  const d = conf.destinatario
  return {
    account: { userID: credenziali.utente, password: credenziali.password },
    createData: {
      network: '',
      departureDepot: conf.filiale_partenza,
      senderCustomerCode: conf.codice_cliente,
      deliveryFreightTypeCode: 'DAP',
      consigneeCompanyName: '',
      consigneeAddress: '',
      consigneeCountryAbbreviationISOAlpha2: '',
      consigneeTelephone: d.telefono,
      consigneeEMail: d.email,
      originalSenderCompanyName: '',
      isAlertRequired: 1,
      insuranceAmount: 0,
      quantityToBeInvoiced: 0.0,
      cashOnDelivery: 0,
      isCODMandatory: '0',
      notes: dati.note.slice(0, 70),
      pricingConditionCode: conf.codice_tariffa,
      declaredParcelValue: 0,
      palletType1Number: 0,
      palletType2Number: 0,
      numericSenderReference: 20,
      alphanumericSenderReference: dati.riferimento.slice(0, 15),
      numberOfParcels: 1,
      weightKG: conf.peso_kg,
      volumeM3: 0.0,
      consigneeZIPCode: '',
      consigneeCity: '',
      consigneeProvinceAbbreviation: '',
      brtServiceCode: conf.codice_servizio,
      pudoId: '',
      returnDepot: conf.filiale_ritorno,
    },
    actualSender: {
      actualSenderName: dati.nome_cliente.slice(0, 70),
      actualSenderCity: '',
      actualSenderAddress: '',
      actualSenderZIPCode: '',
      actualSenderProvince: '',
      actualSenderCountry: '',
      actualSenderEmail: d.email,
      actualSenderMobilePhoneNumber: '',
      actualSenderPudoId: '',
    },
    returnShipmentConsignee: {
      returnShipmentConsigneeName: d.ragione_sociale,
      returnShipmentConsigneeCity: d.citta,
      returnShipmentConsigneeAddress: d.indirizzo,
      returnShipmentConsigneeZIPCode: d.cap,
      returnShipmentConsigneeProvince: d.provincia,
      returnShipmentConsigneeCountry: d.paese,
      returnShipmentConsigneeEmail: d.email,
      returnShipmentConsigneeMobilePhoneNumber: d.telefono,
      returnShipmentConsigneePudoId: '',
    },
    isLabelRequired: 1,
    labelParameters: {
      outputType: 'PDF',
      offsetX: 0,
      offsetY: 0,
      isBorderRequired: '1',
      isLogoRequired: '1',
      isBarcodeControlRowRequired: '0',
    },
  }
}

export type EsitoBrt =
  | { ok: true; parcel_id: string; tracking_parcel_id: string | null; pdf: Buffer; raw: unknown }
  | { ok: false; errore: string; raw: unknown }

/**
 * Legge la risposta. Il `raw` restituito è la risposta integrale meno i
 * byte dell'etichetta (`stream`, `streamDigitalLabel`): il PDF sta su
 * Storage, ripeterlo in ogni riga del database non serve.
 */
export function interpretaRisposta(corpo: unknown): EsitoBrt {
  const r = (corpo as { createResponse?: Record<string, unknown> } | null)?.createResponse
  const msg = r?.executionMessage as { code?: number; message?: string; codeDesc?: string } | undefined
  const etichetta = (r?.labels as { label?: Record<string, unknown>[] } | undefined)?.label?.[0]
  const raw = alleggerisci(corpo)

  const stream = typeof etichetta?.stream === 'string' ? etichetta.stream : ''
  const parcel = typeof etichetta?.parcelID === 'string' ? etichetta.parcelID : ''
  if (stream && parcel && (msg?.code ?? 0) >= 0) {
    return {
      ok: true,
      parcel_id: parcel,
      tracking_parcel_id: typeof etichetta?.trackingByParcelID === 'string' ? etichetta.trackingByParcelID : null,
      pdf: Buffer.from(stream, 'base64'),
      raw,
    }
  }
  const errore = [msg?.code, msg?.codeDesc, msg?.message].filter((x) => x !== undefined && x !== '').join(' - ')
  return { ok: false, errore: errore || 'risposta BRT senza etichetta', raw }
}

function alleggerisci(corpo: unknown): unknown {
  return JSON.parse(JSON.stringify(corpo ?? null), (k, v) =>
    (k === 'stream' || k === 'streamDigitalLabel') && typeof v === 'string' ? `[${v.length} caratteri base64]` : v,
  )
}

export async function richiediEtichetta(
  conf: ConfigBrtResi,
  credenziali: { utente: string; password: string },
  dati: DatiReso,
): Promise<EsitoBrt> {
  const risposta = await fetch(conf.endpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify(costruisciRichiesta(conf, credenziali, dati)),
    signal: AbortSignal.timeout(30_000),
  })
  const testo = await risposta.text()
  let corpo: unknown
  try {
    corpo = JSON.parse(testo)
  } catch {
    return { ok: false, errore: `BRT ha risposto ${risposta.status} con un corpo non JSON: ${testo.slice(0, 200)}`, raw: null }
  }
  const esito = interpretaRisposta(corpo)
  if (!esito.ok && !risposta.ok) return { ...esito, errore: `HTTP ${risposta.status}: ${esito.errore}` }
  return esito
}
