import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'

import { normalizzaEndpoint, costruisciOperatori } from '../src/connectors/mirakl/client.js'
import { normalizzaRisposta } from '../src/connectors/mirakl/normalize.js'

/**
 * ATTENZIONE: la fixture è costruita sullo schema DOCUMENTATO di M11,
 * non su una risposta reale. Vedi test/fixtures/mirakl/LEGGIMI.md.
 * Questi test dimostrano che il normalizzatore fa quello che crediamo,
 * non che i campi veri si chiamino così.
 */
const risposta = JSON.parse(
  readFileSync('test/fixtures/mirakl/threads-m11.json', 'utf8'),
)

const log = { info() {}, warn() {}, error() {}, debug() {} }

describe('normalizzazione M11', () => {
  it('legge i thread e li aggancia all ordine tramite l entità MMP_ORDER', () => {
    const { threads } = normalizzaRisposta(risposta)
    expect(threads).toHaveLength(2)
    expect(threads[0]?.external_thread_id).toBe('thread-0001')
    // Questo è l aggancio esatto che con Amazon non abbiamo: nessun
    // testo da interpretare, l identificativo sta in un campo.
    expect(threads[0]?.external_order_id).toBe('02116_325104572-A')
  })

  it('il verso del messaggio viene dal tipo di mittente', () => {
    const { threads } = normalizzaRisposta(risposta)
    const m = threads[0]!.messaggi
    expect(m[0]?.direzione).toBe('in')
    expect(m[1]?.direzione).toBe('out')
  })

  it('un tipo di mittente sconosciuto viene registrato invece che ignorato', () => {
    // È il caso che non ho potuto verificare: se l enum reale è diverso
    // lo scopriamo da qui, non da un comportamento sbagliato in silenzio.
    const { stranezze } = normalizzaRisposta(risposta)
    const tipi = stranezze.filter((s) => s.tipo === 'mirakl_tipo_mittente')
    expect(tipi.length).toBeGreaterThan(0)
  })

  it('accetta il topic sia come testo sia come oggetto', () => {
    const { threads } = normalizzaRisposta(risposta)
    expect(threads[0]?.oggetto).toBe('Domanda sulla consegna')
    expect(threads[1]?.oggetto).toBe('Richiesta generica')
  })

  it('un thread senza ordine è legittimo, non un errore', () => {
    const { threads } = normalizzaRisposta(risposta)
    expect(threads[1]?.external_order_id).toBeNull()
  })

  it('legge gli allegati', () => {
    const { threads } = normalizzaRisposta(risposta)
    const a = threads[0]!.messaggi[1]!.allegati[0]
    expect(a?.nome_file).toBe('bolla.pdf')
    expect(a?.dimensione_byte).toBe(12345)
  })

  it('conserva sempre il grezzo', () => {
    const { threads } = normalizzaRisposta(risposta)
    expect(threads[0]?.raw).toBe(risposta.data[0])
  })
})

describe('classificazione del mittente — verificata su Leroy Merlin/Adeo reale', () => {
  const threadCon = (tipoMittente: string) => ({
    data: [
      {
        id: 't1',
        messages: [{ id: 'm1', from: { type: tipoMittente, display_name: 'X' }, body: 'ciao' }],
      },
    ],
  })

  it('SHOP_USER è noi: out/agent, nessuna stranezza registrata', () => {
    const { threads, stranezze } = normalizzaRisposta(threadCon('SHOP_USER'))
    const m = threads[0]!.messaggi[0]!
    expect(m.direzione).toBe('out')
    expect(m.autore_kind).toBe('agent')
    expect(stranezze).toEqual([])
  })

  it('OPERATOR_USER è il marketplace, non il cliente: in/system, nessuna stranezza', () => {
    // Verificato su un thread reale: mittente "Operator", notifica
    // automatica di richiesta fattura indirizzata al negozio.
    const { threads, stranezze } = normalizzaRisposta(threadCon('OPERATOR_USER'))
    const m = threads[0]!.messaggi[0]!
    expect(m.direzione).toBe('in')
    expect(m.autore_kind).toBe('system')
    expect(stranezze).toEqual([])
  })

  it('CUSTOMER_USER è il cliente: in/customer', () => {
    const { threads } = normalizzaRisposta(threadCon('CUSTOMER_USER'))
    const m = threads[0]!.messaggi[0]!
    expect(m.direzione).toBe('in')
    expect(m.autore_kind).toBe('customer')
  })

  it('un tipo davvero ignoto resta customer per prudenza, ma si registra', () => {
    const { threads, stranezze } = normalizzaRisposta(threadCon('QUALCOSA_DI_NUOVO'))
    const m = threads[0]!.messaggi[0]!
    expect(m.autore_kind).toBe('customer')
    expect(stranezze.some((s) => s.tipo === 'mirakl_tipo_mittente')).toBe(true)
  })
})

describe('robustezza del normalizzatore', () => {
  it('una risposta senza data non lancia: lo registra', () => {
    const { threads, stranezze } = normalizzaRisposta({ qualcosa: 'altro' })
    expect(threads).toEqual([])
    expect(stranezze[0]?.tipo).toBe('mirakl_risposta_senza_data')
  })

  it('un thread senza id viene saltato e segnalato', () => {
    // Senza identificativo non possiamo essere idempotenti: inserirlo
    // significherebbe duplicarlo a ogni giro.
    const { threads, stranezze } = normalizzaRisposta({ data: [{ topic: 'x' }] })
    expect(threads).toEqual([])
    expect(stranezze.some((s) => s.tipo === 'mirakl_thread_senza_id')).toBe(true)
  })

  it('campi mancanti diventano null, non eccezioni', () => {
    const { threads } = normalizzaRisposta({ data: [{ id: 't1' }] })
    expect(threads[0]?.oggetto).toBeNull()
    expect(threads[0]?.messaggi).toEqual([])
  })
})

describe('configurazione degli operatori', () => {
  const riga = {
    id: 'acc-1', code: 'mirakl-x', display_name: 'X',
    config: { endpoint: 'https://esempio.mirakl.net/' },
    secret_ref: 'CHIAVE_X',
  }

  it('toglie la barra finale dall endpoint', () => {
    expect(normalizzaEndpoint('https://esempio.mirakl.net/')).toBe('https://esempio.mirakl.net')
    expect(normalizzaEndpoint('https://esempio.mirakl.net')).toBe('https://esempio.mirakl.net')
  })

  it('prende la chiave dalla variabile indicata da secret_ref', () => {
    const op = costruisciOperatori([riga], { CHIAVE_X: 'abc' }, log)
    expect(op).toHaveLength(1)
    expect(op[0]?.chiave).toBe('abc')
  })

  it('un operatore senza chiave viene saltato, non fa cadere gli altri', () => {
    const altro = { ...riga, id: 'acc-2', code: 'mirakl-y', secret_ref: 'CHIAVE_Y' }
    const op = costruisciOperatori([riga, altro], { CHIAVE_X: 'abc' }, log)
    expect(op.map((o) => o.code)).toEqual(['mirakl-x'])
  })

  it('un operatore senza endpoint viene saltato', () => {
    const senza = { ...riga, config: {} }
    expect(costruisciOperatori([senza], { CHIAVE_X: 'abc' }, log)).toEqual([])
  })
})
