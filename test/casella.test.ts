import { describe, it, expect } from 'vitest'
import type { Config } from '../src/config.js'
import { trasportoDaRaw, trasportoDi } from '../src/connectors/mail/casella.js'
import { componiMime, mittenteDi } from '../src/connectors/mail/spedizione.js'
import { perArchivio } from '../src/connectors/mail/parse.js'
import type { EmailGrezza } from '../src/connectors/mail/tipi.js'

/**
 * La regola che conta più di tutte durante la migrazione a Microsoft
 * 365: **si risponde sempre dalla stessa casella che ha ricevuto il
 * messaggio.** Il relay di un marketplace accetta risposte solo
 * dall'indirizzo a cui il cliente ha scritto; una risposta dalla casella
 * sbagliata viene rifiutata e il thread si perde.
 */

const config = {
  MAIL_USER: 'vecchia@esempio.test',
  MS_MAILBOX: 'nuova@esempio.test',
} as Config

describe('trasportoDi — la colonna channel_account.transport', () => {
  it("'graph' identifica la casella Microsoft", () => {
    expect(trasportoDi('graph')).toBe('graph')
  })

  it("tutto il resto vale 'imap': le righe esistenti non cambiano comportamento", () => {
    expect(trasportoDi('imap')).toBe('imap')
    expect(trasportoDi(null)).toBe('imap')
    expect(trasportoDi(undefined)).toBe('imap')
    // 'api' è Mirakl/Shopify: non sono caselle, ma non devono mai valere 'graph'.
    expect(trasportoDi('api')).toBe('imap')
  })
})

describe('trasportoDaRaw — da quale casella rispondere', () => {
  it('un messaggio ricevuto dalla casella Microsoft si risponde da lì', () => {
    expect(trasportoDaRaw({ from: 'cliente@relay.test', casella: 'graph' })).toBe('graph')
  })

  it('un messaggio ricevuto da Gmail si risponde da Gmail', () => {
    expect(trasportoDaRaw({ from: 'cliente@relay.test', casella: 'imap' })).toBe('imap')
  })

  it('un nostro invio registra il trasporto: il ticket collegato continua dalla stessa casella', () => {
    expect(trasportoDaRaw({ to: 'corriere@esempio.test', trasporto: 'graph' })).toBe('graph')
  })

  it('i messaggi entrati prima della migrazione erano tutti Gmail', () => {
    expect(trasportoDaRaw({ from: 'cliente@relay.test' })).toBe('imap')
    expect(trasportoDaRaw(null)).toBe('imap')
  })

  it("non guarda l'account del thread: un ticket Amazon entrato da Microsoft risponde da Microsoft", () => {
    // Il caso che ha motivato la scelta: il thread appartiene ad
    // amazon-it (che ha transport='imap' in channel_account), ma il
    // cliente ha scritto alla casella Microsoft. Conta il messaggio.
    const raw = { from: 'alias@marketplace.amazon.test', casella: 'graph' }
    expect(trasportoDaRaw(raw)).toBe('graph')
  })
})

describe('la casella viaggia con il messaggio fino al database', () => {
  const email: EmailGrezza = {
    rfc822_id: 'm1@esempio.test',
    in_reply_to: null,
    references: [],
    from: 'cliente@relay.test',
    reply_to: null,
    to: ['nuova@esempio.test'],
    subject: 'Ordine',
    date: null,
    body_text: 'ciao',
    body_html: null,
    allegati: [],
    uid: null,
    notifica_tipo: null,
    casella: 'graph',
  }

  it('perArchivio la scrive in raw: è da lì che la rilegge la risposta', () => {
    const raw = perArchivio(email)
    expect(raw.casella).toBe('graph')
    expect(trasportoDaRaw(raw)).toBe('graph')
  })
})

describe('mittente e catena della risposta', () => {
  it('ogni trasporto ha il suo mittente, non configurabile a parte', () => {
    expect(mittenteDi(config, 'imap')).toBe('vecchia@esempio.test')
    expect(mittenteDi(config, 'graph')).toBe('nuova@esempio.test')
  })

  it('senza MS_MAILBOX non si risponde dalla casella Microsoft (errore, non un ripiego su Gmail)', () => {
    expect(() => mittenteDi({ MAIL_USER: 'vecchia@esempio.test' } as Config, 'graph')).toThrow(
      /MS_MAILBOX/,
    )
  })

  it('il MIME per Graph parte dalla casella Microsoft e tiene In-Reply-To e References', async () => {
    const { mime, rfc822_id } = await componiMime(config, 'graph', {
      a: 'alias@marketplace.test',
      oggetto: 'Re: Ordine',
      testo: 'Buongiorno',
      inReplyTo: 'originale@relay.test',
      references: ['<primo@relay.test>', '<originale@relay.test>'],
    })
    const testo = mime.toString('utf8')

    expect(testo).toMatch(/^From: nuova@esempio\.test/m)
    expect(testo).not.toContain('vecchia@esempio.test')
    // Senza questi due header ogni risposta sembra una email nuova e il
    // cliente perde il filo: è il motivo per cui su Graph si spedisce MIME.
    expect(testo).toMatch(/^In-Reply-To: <originale@relay\.test>/m)
    expect(testo).toMatch(/^References: <primo@relay\.test> <originale@relay\.test>/m)
    expect(rfc822_id).toBeTruthy()
    expect(rfc822_id).not.toMatch(/[<>]/)
  })
})
