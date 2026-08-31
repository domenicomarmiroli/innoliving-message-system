import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'

import { analizza, normalizzaMessageId } from '../src/connectors/mail/parse.js'
import {
  classificaMittente,
  daEscludere,
  dominioCombacia,
  dominioDi,
  estraiNumeroOrdine,
  indirizzoDi,
  riconosci,
} from '../src/connectors/mail/riconosci.js'
import { tagDaOggetto } from '../src/connectors/mail/notifica.js'
import { regoleDaConfig, ripulisci } from '../src/connectors/mail/ripulisci.js'
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
    testo: regoleDaConfig({}),
  },
  {
    account_id: '22222222-2222-2222-2222-222222222222',
    code: 'mirakl-mms',
    kind: 'mirakl',
    sender_domains: ['notification.mirakl.net'],
    order_id_pattern: null,
    testo: regoleDaConfig({}),
  },
]

const CASELLA: RegolaCanale = {
  account_id: '99999999-9999-9999-9999-999999999999',
  code: 'mailbox-assistenza',
  kind: 'email',
  sender_domains: [],
  order_id_pattern: null,
  testo: regoleDaConfig({}),
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
    to: [], date: null, body_html: null, allegati: [], uid: null, notifica_tipo: null,
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

// =====================================================================
// Pulizia del corpo — su un esemplare REALE di Amazon.it
// (l'unico file di test/fixtures/mail il cui corpo non è inventato)
// =====================================================================
describe('pulizia del corpo', () => {
  it('tiene solo il messaggio del cliente, non l impalcatura di Amazon', async () => {
    const email = await analizza(eml('amazon-messaggio-reale.eml'), 100)
    const pulito = ripulisci(email.body_text, regoleDaConfig({}))

    expect(pulito).toBe('Confermo! Grazie mille Buon lavoro')
    // Le cose che l'operatore non deve vedere
    expect(pulito).not.toContain('Hai ricevuto un messaggio')
    expect(pulito).not.toContain('sellercentral.amazon.it')
    expect(pulito).not.toContain('Copyright')
    expect(pulito).not.toContain('SPC-EU')
    expect(pulito).not.toContain('Nota informativa')
  })

  it('un corpo senza cornice viene solo sfrondato, non svuotato', async () => {
    const email = await analizza(eml('cliente-diretto.eml'), 101)
    const pulito = ripulisci(email.body_text, regoleDaConfig({}))
    expect(pulito).toContain('compatibile')
  })

  it('mai restituire il vuoto: meglio rumoroso che perso', () => {
    const regole = regoleDaConfig({ body_cut: ['^.*$'] })
    expect(ripulisci('testo che sopravvive', regole)).toBe('testo che sopravvive')
  })

  it('delimitatori personalizzati da configurazione', () => {
    const regole = regoleDaConfig({ body_extract: [['^=== INIZIO ===$', '^=== FINE ===$']] })
    const testo = 'rumore\n=== INIZIO ===\nil messaggio\n=== FINE ===\naltro rumore'
    expect(ripulisci(testo, regole)).toBe('il messaggio')
  })

  it('una regex sbagliata in configurazione non fa sparire il corpo', () => {
    const regole = regoleDaConfig({ body_extract: [['([non chiuso', 'nemmeno)']] })
    expect(ripulisci('messaggio del cliente', regole)).toBe('messaggio del cliente')
  })

  it('la riga di apertura non chiude anche se stessa', () => {
    // "--- Messaggio: ---" soddisfa entrambi i modelli: se cercassimo la
    // chiusura dall'inizio, il messaggio risulterebbe vuoto.
    const testo = '--------- Messaggio: ---------\nciao\n--------- Fine ---------'
    expect(ripulisci(testo, regoleDaConfig({}))).toBe('ciao')
  })
})

describe('lista di esclusi', () => {
  const nulla = { rfc822_id: null, in_reply_to: null, references: [], to: [],
    subject: null, date: null, body_text: null, body_html: null,
    allegati: [], uid: null }

  it('esclude il dominio e tutti i suoi sottodomini con una sola voce', () => {
    expect(daEscludere({ ...nulla, from: 'no-reply@google.com', reply_to: null },
      ['google.com'])).toBe(true)
    expect(daEscludere({ ...nulla, from: 'x@accounts.google.com', reply_to: null },
      ['google.com'])).toBe(true)
  })

  it('un cliente che scrive direttamente NON viene escluso', () => {
    // È il punto della lista di esclusi: il caso peggiore è rumore in
    // coda, non un messaggio perso in silenzio.
    expect(daEscludere({ ...nulla, from: 'mario.rossi@libero.it', reply_to: null },
      ['google.com'])).toBe(false)
  })

  it('escludere amazon.com non tocca marketplace.amazon.it', () => {
    // Domini diversi: uno porta le notifiche di mancata consegna,
    // l altro i messaggi veri dei clienti.
    expect(daEscludere({ ...nulla, from: 'x@amazon.com', reply_to: null },
      ['amazon.com'])).toBe(true)
    expect(daEscludere({ ...nulla, from: 'x@marketplace.amazon.it', reply_to: null },
      ['amazon.com'])).toBe(false)
  })

  it('basta che uno fra From e Reply-To sia in lista', () => {
    expect(daEscludere({ ...nulla, from: 'tizio@altro.it', reply_to: 'x@google.com' },
      ['google.com'])).toBe(true)
  })

  it('lista vuota: non esclude niente', () => {
    expect(daEscludere({ ...nulla, from: 'x@google.com', reply_to: null }, []))
      .toBe(false)
  })
})

describe('generi di posta', () => {
  const nulla = { rfc822_id: null, in_reply_to: null, references: [], to: [],
    subject: null, date: null, body_text: null, body_html: null,
    allegati: [], uid: null, notifica_tipo: null }
  const opz = { domini_esclusi: ['google.com'], domini_notifica: ['amazon.com'],
                domini_avviso: [] }

  it('la posta di servizio è esclusa', () => {
    expect(classificaMittente({ ...nulla, from: 'x@google.com', reply_to: null }, opz))
      .toBe('escluso')
  })

  it('l avviso di mancata consegna è una notifica, non un ticket', () => {
    expect(classificaMittente({ ...nulla, from: 'x@amazon.com', reply_to: null }, opz))
      .toBe('notifica')
  })

  it('il relay dei clienti resta un messaggio, non una notifica', () => {
    // La distinzione che tiene in piedi tutto: amazon.com porta avvisi,
    // marketplace.amazon.it porta i clienti.
    expect(classificaMittente(
      { ...nulla, from: 'x@marketplace.amazon.it', reply_to: null }, opz))
      .toBe('messaggio')
  })

  it('un cliente che scrive direttamente è un messaggio', () => {
    expect(classificaMittente({ ...nulla, from: 'mario@libero.it', reply_to: null }, opz))
      .toBe('messaggio')
  })

  it('l esclusione ha la precedenza sulla notifica', () => {
    expect(classificaMittente({ ...nulla, from: 'x@google.com', reply_to: null },
      { domini_esclusi: ['google.com'], domini_notifica: ['google.com'],
        domini_avviso: [] }))
      .toBe('escluso')
  })
})

describe('avvisi su un ordine', () => {
  // Oggetti reali, presi dalla casella.
  const REGOLE_TAG: Array<[string, string]> = [
    ['dalla A alla Z', 'garanzia-a-z'],
    ['Azione richiesta', 'rimborso-richiesto'],
  ]

  it('riconosce la richiesta di garanzia dalla A alla Z', () => {
    expect(tagDaOggetto(
      "La tua richiesta di garanzia Amazon dalla A alla Z per l'ordine 406-7088663-0211",
      REGOLE_TAG)).toBe('garanzia-a-z')
  })

  it('riconosce la richiesta di rimborso con azione richiesta', () => {
    expect(tagDaOggetto(
      'Azione richiesta: Richiesta di rimborso ricevuta per l’ordine 404-9859208-2535',
      REGOLE_TAG)).toBe('rimborso-richiesto')
  })

  it('un oggetto sconosciuto non si perde: prende un tag generico', () => {
    expect(tagDaOggetto('Qualcosa di nuovo da Amazon', REGOLE_TAG))
      .toBe('avviso-piattaforma')
    expect(tagDaOggetto(null, REGOLE_TAG)).toBe('avviso-piattaforma')
  })

  it('il numero d ordine si legge da questi oggetti veri', () => {
    const base = { rfc822_id: null, in_reply_to: null, references: [],
      from: null, reply_to: null, to: [], date: null, body_html: null,
      body_text: null, allegati: [], uid: null, notifica_tipo: null }
    expect(estraiNumeroOrdine({ ...base,
      subject: "La tua richiesta di garanzia Amazon dalla A alla Z per l'ordine 406-7088663-0211913" },
      null)).toBe('406-7088663-0211913')
  })

  it('amazon.it e marketplace.amazon.it restano generi diversi', () => {
    const opz = { domini_esclusi: ['sell.amazon.com'],
                  domini_notifica: ['amazon.com'], domini_avviso: ['amazon.it'] }
    const n = { rfc822_id: null, in_reply_to: null, references: [], to: [],
      subject: null, date: null, body_text: null, body_html: null,
      allegati: [], uid: null, reply_to: null, notifica_tipo: null }
    // marketplace.amazon.it e' sottodominio di amazon.it: senza le
    // regole dei canali finirebbe fra gli avvisi, e il canale
    // principale si spegnerebbe in silenzio.
    expect(classificaMittente({ ...n, from: 'x@amazon.it' }, opz, REGOLE)).toBe('avviso')
    expect(classificaMittente({ ...n, from: 'x@marketplace.amazon.it' }, opz, REGOLE))
      .toBe('messaggio')
    expect(classificaMittente({ ...n, from: 'x@amazon.com' }, opz, REGOLE)).toBe('notifica')
    // L'esclusione vince, nonostante il suffisso amazon.com
    expect(classificaMittente({ ...n, from: 'x@sell.amazon.com' }, opz, REGOLE))
      .toBe('escluso')
  })
})

describe('richieste di reso', () => {
  const n = { rfc822_id: null, in_reply_to: null, references: [], to: [],
    subject: null, date: null, body_text: null, body_html: null,
    allegati: [], uid: null, reply_to: null }
  const opz = { domini_esclusi: [], domini_notifica: ['amazon.com'], domini_avviso: [] }

  it('l header X-Space-Notification-Type vince sul dominio condiviso con le notifiche', () => {
    // amazon.com porta sia le notifiche di mancata consegna sia le
    // richieste di reso: senza guardare l'header finirebbero tutte
    // classificate come notifica, e riaprirebbero il thread sbagliato
    // con il messaggio sbagliato.
    expect(classificaMittente(
      { ...n, from: 'x@amazon.com', notifica_tipo: 'RETURN_REQUEST' }, opz))
      .toBe('reso')
    expect(classificaMittente(
      { ...n, from: 'x@amazon.com', notifica_tipo: null }, opz))
      .toBe('notifica')
  })

  it('un tipo di notifica sconosciuto non diventa un reso', () => {
    expect(classificaMittente(
      { ...n, from: 'x@amazon.com', notifica_tipo: 'ORDER_SHIPPED' }, opz))
      .toBe('notifica')
  })

  it('sulla email reale l header è presente e riconosciuto', async () => {
    const email = await analizza(eml('amazon-richiesta-reso-reale.eml'), 200)
    expect(email.notifica_tipo).toBe('RETURN_REQUEST')
    expect(classificaMittente(email, opz)).toBe('reso')
  })
})

describe('rimborsi emessi', () => {
  const n = { rfc822_id: null, in_reply_to: null, references: [], to: [],
    subject: null, date: null, body_text: null, body_html: null,
    allegati: [], uid: null, reply_to: null }
  const opz = { domini_esclusi: [], domini_notifica: ['amazon.com'], domini_avviso: [] }

  it('REFUND_ISSUED è un rimborso, non una notifica di mancata consegna', () => {
    expect(classificaMittente(
      { ...n, from: 'x@amazon.com', notifica_tipo: 'REFUND_ISSUED' }, opz))
      .toBe('rimborso')
  })

  it('sulla email reale l header è presente e riconosciuto', async () => {
    const email = await analizza(eml('amazon-rimborso-emesso-reale.eml'), 210)
    expect(email.notifica_tipo).toBe('REFUND_ISSUED')
    expect(classificaMittente(email, opz)).toBe('rimborso')
  })
})

describe('reclami di Garanzia dalla A alla Z', () => {
  const n = { rfc822_id: null, in_reply_to: null, references: [], to: [],
    subject: null, date: null, body_text: null, body_html: null,
    allegati: [], uid: null, reply_to: null }
  const opz = { domini_esclusi: [], domini_notifica: ['amazon.com'], domini_avviso: ['amazon.it'] }

  it('A_Z_CLAIM_RESPONDENT_NOTIFY è un reclamo, non un avviso generico per testo', () => {
    expect(classificaMittente(
      { ...n, from: 'atoz-guarantee-no-reply@amazon.it', notifica_tipo: 'A_Z_CLAIM_RESPONDENT_NOTIFY' },
      opz))
      .toBe('reclamo')
  })

  it('senza l header, lo stesso mittente resta un avviso generico', () => {
    expect(classificaMittente(
      { ...n, from: 'atoz-guarantee-no-reply@amazon.it', notifica_tipo: null }, opz))
      .toBe('avviso')
  })

  it('sulla email reale l header è presente e riconosciuto, nonostante l oggetto non parli di reclamo', async () => {
    const email = await analizza(eml('amazon-reclamo-az-reale.eml'), 220)
    expect(email.notifica_tipo).toBe('A_Z_CLAIM_RESPONDENT_NOTIFY')
    // La prova del perché serve l'header: l'oggetto reale non contiene
    // "dalla A alla Z" da nessuna parte, solo il corpo lo dice — con la
    // sola corrispondenza sul testo sarebbe finito nel tag generico.
    expect(email.subject).not.toContain('alla Z')
    expect(classificaMittente(email, opz)).toBe('reclamo')
  })
})
