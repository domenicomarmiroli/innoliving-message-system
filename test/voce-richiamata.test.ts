import { describe, it, expect } from 'vitest'

import {
  REGOLE_PREDEFINITE,
  dentroFascia,
  normalizzaNumero,
  primoTentativo,
  prossimoTentativo,
} from '../src/core/voce/richiamata.js'
import { esitoRichiamata, estraiFallimento, type DatiChiamata } from '../src/core/voce/fine-chiamata.js'

// Ottobre 2026 è ora legale: Italia = UTC+2.
const roma = (iso: string) => new Date(iso + '+02:00')
const oraRoma = (d: Date) =>
  new Intl.DateTimeFormat('it-IT', { timeZone: 'Europe/Rome', day: 'numeric', hour: '2-digit', minute: '2-digit' }).format(d)

describe('fascia oraria 8-21, mai fuori', () => {
  it('dentro e fuori fascia', () => {
    expect(dentroFascia(roma('2026-10-07T07:59'))).toBe(false)
    expect(dentroFascia(roma('2026-10-07T08:00'))).toBe(true)
    expect(dentroFascia(roma('2026-10-07T20:50'))).toBe(true)
    // Margine di 10 minuti: una chiamata non parte a ridosso delle 21.
    expect(dentroFascia(roma('2026-10-07T20:55'))).toBe(false)
    expect(dentroFascia(roma('2026-10-07T21:30'))).toBe(false)
  })

  it('primo tentativo: subito in fascia, alle 8 se è presto, alle 8 di domani se è tardi', () => {
    const giorno = roma('2026-10-07T15:00')
    expect(primoTentativo(giorno)).toEqual(giorno)
    expect(oraRoma(primoTentativo(roma('2026-10-07T06:30')))).toBe('7, 08:00')
    expect(oraRoma(primoTentativo(roma('2026-10-07T22:15')))).toBe('8, 08:00')
  })

  it('anche nel giorno del cambio d’ora (25 ottobre 2026) le 8 restano le 8 italiane', () => {
    expect(oraRoma(primoTentativo(new Date('2026-10-24T21:00:00Z')))).toBe('25, 08:00')
  })
})

describe('tentativi successivi', () => {
  it('fra una e due ore', () => {
    const ora = roma('2026-10-07T10:00')
    const presto = prossimoTentativo(ora, 1, REGOLE_PREDEFINITE, 0)!
    const tardi = prossimoTentativo(ora, 1, REGOLE_PREDEFINITE, 1)!
    expect((presto.getTime() - ora.getTime()) / 60_000).toBe(60)
    expect((tardi.getTime() - ora.getTime()) / 60_000).toBe(120)
  })

  it('se il tentativo cadrebbe dopo le 21, per oggi ci si ferma (non si richiama domani)', () => {
    expect(prossimoTentativo(roma('2026-10-07T20:00'), 1, REGOLE_PREDEFINITE, 0)).toBeNull()
  })

  it('dopo il numero massimo di tentativi ci si ferma', () => {
    expect(prossimoTentativo(roma('2026-10-07T09:00'), 5)).toBeNull()
  })
})

describe('numero di telefono', () => {
  it('normalizza i formati scritti dagli operatori', () => {
    expect(normalizzaNumero('347 123 4567')).toBe('+393471234567')
    expect(normalizzaNumero('0039 02 1234567')).toBe('+39021234567')
    expect(normalizzaNumero('+39 338-523.8380')).toBe('+393385238380')
    expect(normalizzaNumero('+1 307 318 1212')).toBe('+13073181212')
  })
  it('rifiuta ciò che non è un numero, invece di chiamare un numero sbagliato', () => {
    expect(normalizzaNumero('ciao')).toBeNull()
    expect(normalizzaNumero('1234')).toBeNull()
    expect(normalizzaNumero('')).toBeNull()
  })
})

describe('esito della richiamata', () => {
  const base: DatiChiamata = {
    conversation_id: 'c', agent_ref: null, riassunto: null, esito: null, durata_secondi: 30, iniziata_at: null,
    trascrizione: [{ ruolo: 'agente', testo: 'Buongiorno', secondo: 0 }],
    costo_crediti: null, crediti_voce: null, crediti_llm: null, costo_usd: null, chiamata_test: null,
    terminazione: null, cliente_raggiunto: null,
  }
  it('il cliente ha parlato: risposto', () => {
    expect(esitoRichiamata({ ...base, trascrizione: [...base.trascrizione, { ruolo: 'cliente', testo: 'Sì, sono io', secondo: 2 }] })).toBe('risposto')
  })
  it('nessuna parola del cliente: non raggiunto', () => {
    expect(esitoRichiamata(base)).toBe('non_raggiunto')
  })
  it('segreteria riconosciuta dal motivo di chiusura', () => {
    expect(esitoRichiamata({ ...base, terminazione: 'voicemail_detected' })).toBe('segreteria')
  })
  it('ha risposto qualcun altro: la raccolta dati lo dice', () => {
    expect(esitoRichiamata({ ...base, cliente_raggiunto: false, trascrizione: [...base.trascrizione, { ruolo: 'cliente', testo: 'Non c’è', secondo: 2 }] })).toBe('non_raggiunto')
  })
  it('chiamata mai partita: nessuna risposta o occupato', () => {
    expect(estraiFallimento({ type: 'call_initiation_failure', data: { conversation_id: 'x', failure_reason: 'busy' } })).toEqual({ conversation_id: 'x', motivo: 'busy' })
    expect(estraiFallimento({ type: 'post_call_transcription', data: {} })).toBeNull()
  })
})
