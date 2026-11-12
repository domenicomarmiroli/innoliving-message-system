import { describe, it, expect } from 'vitest'
import { leggiAutomazione, type RigaAutomazione } from '../src/core/automazioni/regole.js'
import {
  compilaAvvisoSpedizione,
  emailContattabile,
  eventoRecente,
  righeEventi,
  type EventoCorriere,
} from '../src/core/automazioni/spedizione.js'

// La stessa riga che la migrazione 0052 inserisce.
const RIGA: RigaAutomazione = {
  id: 'a3',
  codice: 'avviso-spedizione-problema',
  attiva: true,
  account_code: null,
  condizione: { stati_spedizione: ['giacenza', 'problema'], domini_esclusi: ['codisto.com', 'bricobravo.com'] },
  azione: 'avviso_spedizione',
  parametri: { modelli: { giacenza: 'Avviso spedizione in giacenza', problema: 'Avviso problema di consegna' }, max_eta_ore: 72 },
}

// Eventi reali di una spedizione BRT (ordine dello screenshot), dal più recente.
const EVENTI: EventoCorriere[] = [
  { data: '2026-11-11', ora: '15:09', evento: 'Destin.Assente:LASCIATO AVVISO', filiale: 'POMEZIA (114)' },
  { data: '2026-11-11', ora: null, evento: 'IN CONSEGNA', filiale: 'POMEZIA (114)' },
  { data: '2026-11-11', ora: '05:50', evento: 'ARRIVATA IN FILIALE', filiale: 'POMEZIA (114)' },
  { data: '2026-11-10', ora: '21:00', evento: 'PARTITA', filiale: 'ANCONA (066)' },
]

describe('regola avviso_spedizione', () => {
  it('la riga della migrazione è valida, senza condizioni sull\'oggetto', () => {
    const l = leggiAutomazione(RIGA)
    expect(l.ok).toBe(true)
    if (l.ok) expect(l.automazione.parametri.modelli.giacenza).toBe('Avviso spedizione in giacenza')
  })

  it('senza stati non vale', () => {
    expect(leggiAutomazione({ ...RIGA, condizione: {} }).ok).toBe(false)
  })

  it('uno stato senza modello non vale', () => {
    expect(leggiAutomazione({ ...RIGA, parametri: { modelli: { giacenza: 'X' } } }).ok).toBe(false)
  })
})

describe('chi si può avvisare', () => {
  const esclusi = ['codisto.com', 'bricobravo.com']
  it('Amazon via connettore (codisto) no', () => {
    expect(emailContattabile('abc123@mail.codisto.com', esclusi)).toBe(false)
  })
  it('l\'indirizzo del marketplace BricoBravo no', () => {
    expect(emailContattabile('marketplace@bricobravo.com', esclusi)).toBe(false)
  })
  it('TikTok, eBay e le email in chiaro sì', () => {
    expect(emailContattabile('v4bcdusd@scs3.tiktok.com', esclusi)).toBe(true)
    expect(emailContattabile('mario@members.ebay.com', esclusi)).toBe(true)
    expect(emailContattabile('mario.rossi@gmail.com', esclusi)).toBe(true)
  })
  it('email assente o non valida no', () => {
    expect(emailContattabile(null, esclusi)).toBe(false)
    expect(emailContattabile('non-una-email', esclusi)).toBe(false)
  })
})

describe('evento recente', () => {
  it('un evento di ieri vale', () => {
    expect(eventoRecente(EVENTI, new Date('2026-11-12T10:00:00+01:00'), 72)).toBe(true)
  })
  it('una giacenza di due settimane fa no (accendere la regola non scrive a tutti)', () => {
    expect(eventoRecente(EVENTI, new Date('2026-11-26T10:00:00+01:00'), 72)).toBe(false)
  })
  it('senza eventi no', () => {
    expect(eventoRecente([], new Date(), 72)).toBe(false)
  })
})

describe('testo dell\'avviso', () => {
  const dati = {
    nome_cliente: 'IVANKA IVANOVA',
    numero_ordine: 'INSH13787',
    tracking_numero: '066061863485',
    tracking_link: 'https://vas.brt.it/vas/sped_det_show.hsm?Nspediz=066061863485',
    eventi: EVENTI,
    giacenza: null,
  }

  it('compila nome, ordine, tracking ed eventi', () => {
    const r = compilaAvvisoSpedizione(
      'Buongiorno {{cliente.nome}},\nordine {{ordine.numero}}\n{{tracking.link}}\n{{tracking.eventi}}',
      dati,
    )
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.testo).toContain('Buongiorno Ivanka Ivanova,')
    expect(r.testo).toContain('INSH13787')
    expect(r.testo).toContain('Nspediz=066061863485')
    expect(r.testo).toContain('- 11/11 15:09 · POMEZIA (114) — Destin.Assente:LASCIATO AVVISO')
  })

  it('una riga senza dato non si spedisce ("Numero di giacenza: " vuoto)', () => {
    const r = compilaAvvisoSpedizione('A\nNumero di giacenza: {{giacenza.numero}}\nB', dati)
    expect(r.ok && r.testo).toBe('A\nB')
  })

  it('il motivo della giacenza, se manca, è l\'ultimo evento', () => {
    const r = compilaAvvisoSpedizione('Motivo: {{giacenza.motivo}}', dati)
    expect(r.ok && r.testo).toBe('Motivo: Destin.Assente:LASCIATO AVVISO')
  })

  it('un segnaposto sconosciuto blocca l\'invio', () => {
    expect(compilaAvvisoSpedizione('Ciao {{cliente.cognome}}', dati).ok).toBe(false)
  })

  it('righe degli eventi dal più recente, al massimo sei', () => {
    const molti = Array.from({ length: 9 }, (_, i) => ({ data: `2026-11-0${i + 1}`, evento: `E${i + 1}` }))
    const righe = righeEventi(molti).split('\n')
    expect(righe).toHaveLength(6)
    expect(righe[0]).toContain('E9')
  })
})
