import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'

import { analizza, normalizzaMessageId } from '../src/connectors/mail/parse.js'
import {
  dominioCombacia,
  dominioDi,
  estraiNumeroOrdine,
  indirizzoDi,
  riconosci,
} from '../src/connectors/mail/riconosci.js'
import type { RegolaCanale } from '../src/connectors/mail/tipi.js'

/**
 * ATTENZIONE: le fixture in test/fixtures/mail sono sintetiche.
 * Vedi test/fixtures/mail/LEGGIMI.md. Questi test dimostrano che il
 * codice fa quello che crediamo, non che i formati veri siano questi.
 */

const eml = (nome: string) => readFileSync(`test/fixtures/mail/${nome}`)

// Le regole arrivano dal database: qui le costruiamo a mano, con gli
// stessi valori che la migrazione 0002 scrive in channel_account.
const REGOLE: RegolaCanale[] = [
  {
    account_id: '11111111-1111-1111-1111-111111111111',
    code: 'amazon-it',
    kind: 'amazon',
    sender_domains: ['marketplace.amazon.it', 'marketplace.amazon.de'],
    order_id_pattern: '\\d{3}-\\d{7}-\\d{7}',
  },
  {
    account_id: '22222222-2222-2222-2222-222222222222',
    code: 'mirakl-mms',
    kind: 'mirakl',
    sender_domains: ['notification.mirakl.net'],
    order_id_pattern: null,
  },
]

const CASELLA: RegolaCanale = {
  account_id: '99999999-9999-9999-9999-999999999999',
  code: 'mailbox-assistenza',
  kind: 'email',
  sender_domains: [],
  order_id_pattern: null,
}

describe('estrazione del dominio', () => {
  it('accetta sia l indirizzo nudo sia la forma con il nome', () => {
    expect(dominioDi('tizio@esempio.it')).toBe('esempio.it')
    expect(dominioDi('Mario Rossi <tizio@ESEMPIO.it>')).toBe('esempio.it')
  })

  it('non si fa ingannare da una stringa senza chiocciola', () => {
    expect(dominioDi('non un indirizzo')).toBeNull()
    expect(dominioDi('')).toBeNull()
    expect(dominioDi(null)).toBeNull()
  })

  it('rifiuta la chiocciola in posizione degenere', () => {
    expect(dominioDi('@esempio.it')).toBeNull()
    expect(dominioDi('tizio@')).toBeNull()
  })
})

describe('confronto dei domini', () => {
  it('accetta il dominio esatto e i suoi sottodomini', () => {
    expect(dominioCombacia('marketplace.amazon.it', 'marketplace.amazon.it')).toBe(true)
    expect(dominioCombacia('a.marketplace.amazon.it', 'marketplace.amazon.it')).toBe(true)
  })

  it('rifiuta un dominio che contiene la regola senza esserne un sottodominio', () => {
    // Questo è il caso che un confronto con includes lascerebbe passare,
    // ed è esattamente come si fa arrivare posta falsa a un sistema che
    // decide in base al mittente.
    expect(dominioCombacia('marketplace.amazon.it.truffa.com', 'marketplace.amazon.it'))
      .toBe(false)
    expect(dominioCombacia('finto-marketplace.amazon.it.co', 'marketplace.amazon.it'))
      .toBe(false)
  })
})

describe('riconoscimento del canale su esemplari', () => {
  it('Mirakl: dal dominio del relay, con l alias del mittente', async () => {
    const email = await analizza(eml('mirakl.eml'), 10)
    const r = riconosci(email, REGOLE, CASELLA)
    expect(r.kind).toBe('mirakl')
    expect(r.account_code).toBe('mirakl-mms')
    expect(r.alias).toBe('rk0idlx32ez.fznm52pke@notification.mirakl.net')
    expect(r.strategia).toBe('alias')
  })

  it('Amazon: canale dal dominio e numero d ordine dall oggetto', async () => {
    const email = await analizza(eml('amazon.eml'), 11)
    const r = riconosci(email, REGOLE, CASELLA)
    expect(r.kind).toBe('amazon')
    expect(r.numero_ordine).toBe('304-0904527-7250707')
  })

  it('cliente diretto: nessun relay, va sulla casella e non inventa un canale', async () => {
    const email = await analizza(eml('cliente-diretto.eml'), 12)
    const r = riconosci(email, REGOLE, CASELLA)
    expect(r.kind).toBe('email')
    expect(r.account_id).toBe(CASELLA.account_id)
    expect(r.strategia).toBe('nessuna')
  })

  it('il Reply-To ha la precedenza sul From', async () => {
    const email = await analizza(eml('mirakl.eml'), 13)
    expect(indirizzoDi(email.reply_to)).toBe(email.from)
    const r = riconosci({ ...email, from: 'altro@estraneo.it' }, REGOLE, CASELLA)
    expect(r.kind).toBe('mirakl')
  })
})

describe('catena della conversazione', () => {
  it('legge In-Reply-To e References, senza parentesi angolari', async () => {
    const email = await analizza(eml('risposta-cliente.eml'), 20)
    expect(email.in_reply_to).toBe('nostra-risposta-0001@esempio.it')
    expect(email.references).toEqual([
      'mirakl-0001@notification.mirakl.net',
      'nostra-risposta-0001@esempio.it',
    ])
  })

  it('normalizza il Message-ID allo stesso modo comunque sia scritto', () => {
    expect(normalizzaMessageId('<abc@x.it>')).toBe('abc@x.it')
    expect(normalizzaMessageId('  <abc@x.it>  ')).toBe('abc@x.it')
    expect(normalizzaMessageId('abc@x.it')).toBe('abc@x.it')
    expect(normalizzaMessageId('')).toBeNull()
    expect(normalizzaMessageId(null)).toBeNull()
  })
})

describe('numero d ordine', () => {
  const base = {
    rfc822_id: null, in_reply_to: null, references: [], from: null, reply_to: null,
    to: [], date: null, body_html: null, allegati: [], uid: null,
  }

  it('preferisce l oggetto al corpo: il corpo puo citare altri ordini', () => {
    const trovato = estraiNumeroOrdine(
      { ...base, subject: 'Ordine 111-1111111-1111111', body_text: 'prima era 222-2222222-2222222' },
      null,
    )
    expect(trovato).toBe('111-1111111-1111111')
  })

  it('ripiega sul corpo quando l oggetto non ne ha', () => {
    const trovato = estraiNumeroOrdine(
      { ...base, subject: 'Nessun numero qui', body_text: 'ordine 333-3333333-3333333' },
      null,
    )
    expect(trovato).toBe('333-3333333-3333333')
  })

  it('un pattern scritto male in configurazione non ferma l ingestione', () => {
    const trovato = estraiNumeroOrdine(
      { ...base, subject: 'Ordine 444-4444444-4444444', body_text: null },
      '([non chiuso',
    )
    expect(trovato).toBe('444-4444444-4444444')
  })

  it('restituisce null quando non c e niente da trovare', () => {
    expect(estraiNumeroOrdine({ ...base, subject: 'ciao', body_text: 'come va' }, null))
      .toBeNull()
  })
})

describe('parsing', () => {
  it('conserva oggetto, data e corpo', async () => {
    const email = await analizza(eml('cliente-diretto.eml'), 1)
    expect(email.subject).toBe('Informazioni prodotto')
    expect(email.from).toBe('mario.rossi@esempio-cliente.it')
    expect(email.date?.toISOString()).toBe('2026-08-24T09:02:19.000Z')
    expect(email.body_text).toContain('compatibile')
    expect(email.uid).toBe(1)
  })
})
