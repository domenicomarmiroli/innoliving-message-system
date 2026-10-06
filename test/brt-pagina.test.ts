import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { leggiPagina, statoDaEventi, type EventoBrt } from '../src/connectors/brt/pagina.js'
import { testoAvviso } from '../src/connectors/brt/tracking.js'

const fixture = (nome: string) => readFileSync(new URL(`./fixtures/brt/${nome}`, import.meta.url), 'latin1')

describe('leggiPagina — esemplari reali', () => {
  it('consegnata dopo una giacenza risolta: vince la consegna, la giacenza resta come storia', () => {
    const p = leggiPagina(fixture('consegnata-dopo-giacenza.html'))
    if (!p.riconosciuta || !p.trovata) throw new Error('pagina non letta')
    expect(p.stato).toBe('consegnato')
    expect(p.eventi[0]).toEqual({ data: '2026-10-05', ora: '12:57', filiale: 'GUIDONIA (142)', evento: 'CONSEGNATA' })
    expect(p.eventi.at(-1)?.evento).toBe('DATI SPEDIZ. TRASMESSI A BRT')
    expect(p.eventi.some((e) => e.evento === 'DESTINATAR.SCONOSC./INCOMPLETO')).toBe(true)
    expect(p.giacenza).toMatchObject({ aperta_il: '2026-09-30', stato: 'Evasa', motivazione: 'DESTINATAR.SCONOSC./INCOMPLETO', disposizioni: 'CONSEGNA' })
  })

  it('in viaggio: eventi e consegna stimata', () => {
    const p = leggiPagina(fixture('in-transito.html'))
    if (!p.riconosciuta || !p.trovata) throw new Error('pagina non letta')
    expect(p.stato).toBe('in_transito')
    expect(p.consegna_prevista).toBe('2026-10-07')
    expect(p.giacenza).toBeNull()
    expect(p.eventi.map((e) => e.evento)).toContain('PARTITA')
  })

  it('numero inesistente: riconosciuta ma non trovata, non un errore', () => {
    expect(leggiPagina(fixture('non-trovata.html'))).toEqual({ riconosciuta: true, trovata: false })
  })

  it('una pagina cambiata non diventa uno stato inventato', () => {
    expect(leggiPagina('<html><body>Benvenuto</body></html>').riconosciuta).toBe(false)
  })
})

describe('statoDaEventi', () => {
  const ev = (...nomi: string[]): EventoBrt[] => nomi.map((evento) => ({ data: '2026-10-01', ora: null, filiale: null, evento }))

  it('ultimo evento problematico', () => {
    expect(statoDaEventi(ev('DESTINATAR.SCONOSC./INCOMPLETO', 'IN CONSEGNA'), null)).toBe('problema')
    expect(statoDaEventi(ev('DESTINATARIO ASSENTE', 'IN CONSEGNA'), null)).toBe('problema')
  })
  it('giacenza aperta', () => {
    expect(
      statoDaEventi(ev('DESTINATAR.SCONOSC./INCOMPLETO'), {
        numero: '1', aperta_il: '2026-10-01', stato: 'Aperta', motivazione: null, disposizioni: null,
      }),
    ).toBe('giacenza')
  })
  it('in consegna, in transito, solo dati trasmessi', () => {
    expect(statoDaEventi(ev('IN CONSEGNA', 'ARRIVATA IN FILIALE'), null)).toBe('in_consegna')
    expect(statoDaEventi(ev('PARTITA', 'RITIRATA'), null)).toBe('in_transito')
    expect(statoDaEventi(ev('DATI SPEDIZ. TRASMESSI A BRT'), null)).toBe('spedito')
  })
})

describe('testoAvviso', () => {
  it("l'evento come lo scrive BRT, con data, ora e filiale", () => {
    expect(
      testoAvviso('problema', { data: '2026-09-30', ora: '14:27', filiale: 'GUIDONIA (142)', evento: 'DESTINATAR.SCONOSC./INCOMPLETO' }, '066061619930'),
    ).toBe('Problema nella consegna BRT: «DESTINATAR.SCONOSC./INCOMPLETO» — 30/09/2026 14:27, GUIDONIA (142) (spedizione 066061619930).')
  })
})
