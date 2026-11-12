import { describe, it, expect } from 'vitest'
import {
  combacia,
  decidiRisposta,
  leggiAutomazione,
  modelloSpedibile,
  notaChiusura,
  puoChiudere,
  trovaAutomazione,
  type Automazione,
  type MessaggioThread,
  type RigaAutomazione,
} from '../src/core/automazioni/regole.js'

// Le stesse righe che la migrazione 0050 inserisce, ma accese.
const RIGA_BRICO: RigaAutomazione = {
  id: 'a1',
  codice: 'bricobravo-nuovo-ordine',
  attiva: true,
  account_code: 'mailbox-ticket',
  condizione: {
    oggetto_inizia_per: ['BricoBravo - Nuovo ordine #BB'],
    mittente_dominio: ['bricobravo.com'],
  },
  azione: 'chiudi',
  parametri: { nota: 'Chiuso in automatico: avviso nuovo ordine BricoBravo.' },
}

const RIGA_LM: RigaAutomazione = {
  id: 'a2',
  codice: 'leroymerlin-richiesta-fattura',
  attiva: true,
  account_code: 'mirakl-lmfr',
  condizione: {
    oggetto_uguale: ['ORDER_MESSAGING_askinvoice', 'ORDER_MESSAGING_REMINDER_ASKINVOICE'],
  },
  azione: 'rispondi_e_chiudi',
  parametri: {
    modello: 'Fattura Leroymerlin',
    destinatari_mirakl: ['CUSTOMER'],
    tag: ['risposta-automatica'],
    max_eta_ore: 48,
  },
}

function leggi(r: RigaAutomazione): Automazione {
  const l = leggiAutomazione(r)
  if (!l.ok) throw new Error(l.motivo)
  return l.automazione
}

const BRICO = leggi(RIGA_BRICO)
const LM = leggi(RIGA_LM)
const MITTENTE_BRICO = 'BricoBravo <marketplace@bricobravo.com>'

describe('lettura delle regole dal database', () => {
  it('una regola senza condizioni sull\'oggetto non vale (mai "chiudi tutto")', () => {
    const r = leggiAutomazione({ ...RIGA_BRICO, condizione: { mittente_dominio: ['bricobravo.com'] } })
    expect(r.ok).toBe(false)
  })

  it('azione sconosciuta: la regola non vale', () => {
    expect(leggiAutomazione({ ...RIGA_BRICO, azione: 'cancella' }).ok).toBe(false)
  })

  it('rispondi_e_chiudi senza modello non vale', () => {
    expect(leggiAutomazione({ ...RIGA_LM, parametri: {} }).ok).toBe(false)
  })

  it('destinatari Mirakl: di default solo il cliente, valori ignoti scartati', () => {
    const l = leggi({ ...RIGA_LM, parametri: { modello: 'X', destinatari_mirakl: ['CUSTOMER', 'BOH'] } })
    expect(l.parametri.destinatari_mirakl).toEqual(['CUSTOMER'])
    const vuoto = leggi({ ...RIGA_LM, parametri: { modello: 'X' } })
    expect(vuoto.parametri.destinatari_mirakl).toEqual(['CUSTOMER'])
    expect(vuoto.parametri.max_eta_ore).toBe(48)
  })
})

describe('BricoBravo "Nuovo ordine"', () => {
  const ctx = (oggetto: string, mittente = MITTENTE_BRICO, account_code = 'mailbox-ticket') => ({
    account_code,
    oggetto,
    mittente,
  })

  it('riconosce l\'avviso di nuovo ordine (esempio reale del ticket 12989)', () => {
    expect(combacia(BRICO, ctx('BricoBravo - Nuovo ordine #BB920450388-F1'))).toBe(true)
  })

  it('NON prende "prodotto non presente su Shopify"', () => {
    expect(combacia(BRICO, ctx('BricoBravo BB920449073-F1: prodotto non presente su Shopify'))).toBe(false)
  })

  it('NON prende le risposte ai reclami, che arrivano dallo stesso mittente', () => {
    expect(combacia(BRICO, ctx("Nuova risposta al reclamo per l'ordine #BB920107606-F1"))).toBe(false)
    expect(combacia(BRICO, ctx("Aggiornamento del ticket per l'ordine BB920448680-F1"))).toBe(false)
  })

  it('NON prende lo stesso oggetto da un altro mittente (dominio per suffisso, non includes)', () => {
    expect(combacia(BRICO, ctx('BricoBravo - Nuovo ordine #BB1', 'x@bricobravo.com.truffa.it'))).toBe(false)
    expect(combacia(BRICO, ctx('BricoBravo - Nuovo ordine #BB1', null as unknown as string))).toBe(false)
  })

  it('NON vale su un\'altra casella', () => {
    expect(combacia(BRICO, ctx('BricoBravo - Nuovo ordine #BB1', MITTENTE_BRICO, 'mailbox-assistenza'))).toBe(false)
  })

  it('una regola spenta non scatta', () => {
    const spenta = leggi({ ...RIGA_BRICO, attiva: false })
    expect(trovaAutomazione([spenta], 'chiudi', ctx('BricoBravo - Nuovo ordine #BB1'))).toBeNull()
    expect(trovaAutomazione([BRICO], 'chiudi', ctx('BricoBravo - Nuovo ordine #BB1'))?.codice).toBe(
      'bricobravo-nuovo-ordine',
    )
  })

  it('chiude solo se TUTTO ciò che è in attesa è un avviso da archiviare', () => {
    const avviso = ctx('BricoBravo - Nuovo ordine #BB1')
    const reclamo = ctx("Nuova risposta al reclamo per l'ordine #BB2")
    expect(puoChiudere(BRICO, [avviso, avviso])).toBe(true)
    expect(puoChiudere(BRICO, [reclamo, avviso])).toBe(false)
    expect(puoChiudere(BRICO, [])).toBe(false)
  })

  it('la nota interna è quella scritta nella regola', () => {
    expect(notaChiusura(BRICO)).toBe('Chiuso in automatico: avviso nuovo ordine BricoBravo.')
  })
})

describe('Leroy Merlin, richiesta fattura', () => {
  const ctx = (oggetto: string, account_code = 'mirakl-lmfr') => ({ account_code, oggetto, mittente: null })

  it('riconosce i due oggetti, senza badare alle maiuscole', () => {
    expect(combacia(LM, ctx('ORDER_MESSAGING_askinvoice'))).toBe(true)
    expect(combacia(LM, ctx('ORDER_MESSAGING_REMINDER_ASKINVOICE'))).toBe(true)
    expect(combacia(LM, ctx('order_messaging_askinvoice'))).toBe(true)
  })

  it('MediaMarkt (ORDER_MESSAGING_07) e gli altri operatori restano fuori', () => {
    expect(combacia(LM, ctx('ORDER_MESSAGING_07'))).toBe(false)
    expect(combacia(LM, ctx('ORDER_MESSAGING_askinvoice', 'mirakl-mms'))).toBe(false)
    // oggetto_uguale è un confronto esatto, non un prefisso
    expect(combacia(LM, ctx('ORDER_MESSAGING_askinvoice_bis'))).toBe(false)
  })

  const ora = new Date('2026-11-12T10:00:00Z')
  const richiesta: MessaggioThread = {
    direction: 'in',
    author_kind: 'system',
    interno: false,
    sent_at: new Date('2026-11-12T08:00:00Z'),
  }

  it('risponde alla notifica dell\'operatore appena arrivata', () => {
    expect(decidiRisposta([richiesta], ora, 48)).toEqual({ rispondi: true })
  })

  it('una sola risposta: se nel thread c\'è già una nostra risposta, niente', () => {
    const risposta: MessaggioThread = { ...richiesta, direction: 'out', author_kind: 'agent' }
    expect(decidiRisposta([richiesta, risposta], ora, 48)).toEqual({ rispondi: false, motivo: 'gia_risposto' })
  })

  it('una nota interna non conta come risposta', () => {
    const nota: MessaggioThread = { ...richiesta, direction: 'out', author_kind: 'agent', interno: true }
    expect(decidiRisposta([richiesta, nota], ora, 48)).toEqual({ rispondi: true })
  })

  it('se ha scritto il cliente con parole sue, decide un operatore', () => {
    const cliente: MessaggioThread = { ...richiesta, author_kind: 'customer' }
    expect(decidiRisposta([richiesta, cliente], ora, 48)).toEqual({
      rispondi: false,
      motivo: 'scritto_dal_cliente',
    })
  })

  it('accendere la regola non fa rispondere a richieste vecchie', () => {
    const vecchia: MessaggioThread = { ...richiesta, sent_at: new Date('2026-11-01T08:00:00Z') }
    expect(decidiRisposta([vecchia], ora, 48)).toEqual({ rispondi: false, motivo: 'troppo_vecchio' })
  })

  it('senza nessun messaggio in arrivo non risponde', () => {
    expect(decidiRisposta([], ora, 48)).toEqual({ rispondi: false, motivo: 'nessuna_richiesta' })
  })
})

describe('il modello da spedire', () => {
  it('un modello pronto passa', () => {
    expect(modelloSpedibile('Buongiorno\n\ncordiali saluti')).toBeNull()
  })

  it('un segnaposto non compilato blocca l\'invio', () => {
    expect(modelloSpedibile('Gentile {{cliente.nome}}')).not.toBeNull()
  })

  it('un modello vuoto blocca l\'invio', () => {
    expect(modelloSpedibile('   ')).not.toBeNull()
    expect(modelloSpedibile(null)).not.toBeNull()
  })
})
