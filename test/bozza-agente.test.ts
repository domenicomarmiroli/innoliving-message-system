import { describe, expect, it } from 'vitest'

import { formattaContestoOrdine, type DatiOrdine } from '../src/core/ai/bozza-contesto.js'
import {
  FAMIGLIE,
  PROMPT_VERSION,
  compilaModello,
  costruisciSistema,
  interpretaRispostaAgente,
} from '../src/core/ai/bozza-prompt.js'
import { esitoSenzaId, somiglianza } from '../src/core/ai/esito.js'
import { check } from '../src/core/policy.js'

const OGGI = new Date('2026-11-04T10:00:00Z')

function ordine(parziale: Partial<DatiOrdine>): DatiOrdine {
  return {
    canale: 'amazon',
    operatore: null,
    fba: false,
    numero: '404-0000000-0000000',
    data_ordine: new Date('2026-10-01T10:00:00Z'),
    stato_pagamento: 'paid',
    stato_evasione: 'fulfilled',
    corriere: 'BRT',
    tracking: '066000000001',
    tracking_url: null,
    spedizione_stato: null,
    spedizione_data: null,
    consegna_prevista: null,
    giacenza: null,
    eventi: null,
    reso_richiesto_at: null,
    reso_corriere: null,
    reso_tracking: null,
    rimborso_totale: null,
    rimborso_emesso_at: null,
    reclamo_az_importo: null,
    reclamo_az_ricevuto_at: null,
    valuta: 'EUR',
    righe: [{ sku: 'ABC123', titolo: 'Frullatore', quantita: 1 }],
    etichette_reso: [],
    rientrato_logistica: false,
    foto_ricevute: 0,
    stato_ticket: 'open',
    ticket_collegato: false,
    tag: [],
    costo_prodotto: null,
    ...parziale,
  }
}

describe('prompt v2', () => {
  const p = costruisciSistema()
  it('è versionato', () => expect(PROMPT_VERSION).toBe('v2'))
  it('contiene le sei decisioni del 2026-11-04', () => {
    expect(p).toContain('14 giorni')
    expect(p).toContain('decide SEMPRE l\'operatore')
    expect(p).toContain('Rimborso parziale: non lo offri')
    expect(p).toContain('modello già pronto')
    expect(p).toContain('niente sostituzione')
    expect(p).toContain('non si consiglia il rimborso')
  })
  it('vieta costo al cliente, link su Amazon, trattino lungo', () => {
    expect(p).toContain('MAI nella bozza')
    expect(p).toContain('mai link né indirizzi email')
    expect(p).toContain('mai il trattino lungo')
  })
})

describe('contesto ordine', () => {
  it('senza ordine dice di non affermare nulla', () => {
    expect(formattaContestoOrdine(null)).toContain('Nessun ordine collegato')
  })
  it('garanzia fuori termine: giorni dalla consegna', () => {
    const t = formattaContestoOrdine(
      ordine({ spedizione_stato: 'consegnato', spedizione_data: new Date('2026-09-01') }),
      OGGI,
    )
    expect(t).toContain('consegnato il 2026-09-01 (64 giorni fa')
  })
  it('giacenza BRT e rimborso non emesso', () => {
    const t = formattaContestoOrdine(
      ordine({ spedizione_stato: 'giacenza', giacenza: { motivo: 'destinatario assente' } }),
      OGGI,
    )
    expect(t).toContain('Giacenza presente')
    expect(t).toContain('Rimborso già emesso: no')
  })
  it('costo prodotto solo marcato per la nota operatore', () => {
    const t = formattaContestoOrdine(
      ordine({ costo_prodotto: { sku: 'ABC123', costo: 12.5, valuta: 'EUR' } }),
      OGGI,
    )
    expect(t).toContain("SOLO PER LA NOTA ALL'OPERATORE")
    expect(t).toContain('12.50 EUR')
  })
  it('FBA, foto ricevute ed etichetta esistente', () => {
    const t = formattaContestoOrdine(
      ordine({ fba: true, foto_ricevute: 3, etichette_reso: [{ tipo: 'verificare', stato: 'creata' }] }),
      OGGI,
    )
    expect(t).toContain('FBA')
    expect(t).toContain('Foto già ricevute dal cliente in questo ticket: 3')
    expect(t).toContain('verificare (creata)')
  })
  it('non include dati personali del cliente', () => {
    const t = formattaContestoOrdine(ordine({}), OGGI)
    expect(t).not.toMatch(/@|via |telefono/i)
  })
})

describe('interpretaRispostaAgente', () => {
  it('JSON valido, azione separata dal testo', () => {
    const r = interpretaRispostaAgente(
      JSON.stringify({
        famiglia: 'danneggiato_sbagliato',
        lingua: 'it',
        bozza: 'Buongiorno, ci spiace per quanto accaduto.\n\nCi invii tre foto.',
        azione: { tipo: 'decide_domenico', testo: 'Rimborso con o senza reso.', condizione: 'dopo le foto' },
        nota_operatore: 'Costo di acquisto 12,50 EUR, sotto i 15: non far rendere.',
        decide_domenico: true,
      }),
    )
    expect(r.famiglia).toBe('danneggiato_sbagliato')
    expect(r.azione.tipo).toBe('decide_domenico')
    expect(r.bozza).not.toContain('12,50')
    expect(r.nota_operatore).toContain('12,50')
  })
  it('JSON dentro testo extra viene letto', () => {
    const r = interpretaRispostaAgente('Ecco: {"famiglia":"giacenza","bozza":"Buongiorno","azione":{"tipo":"svincolare_giacenza","testo":"x"}}')
    expect(r.famiglia).toBe('giacenza')
    expect(r.azione.tipo).toBe('svincolare_giacenza')
  })
  it('valori fuori lista non passano', () => {
    const r = interpretaRispostaAgente('{"famiglia":"inventata","bozza":"ciao","azione":{"tipo":"rimborsa_ora"}}')
    expect(r.famiglia).toBe('altro')
    expect(r.azione.tipo).toBe('nessuna')
  })
  it('JSON storto: testo grezzo e decide Domenico', () => {
    const r = interpretaRispostaAgente('non è json')
    expect(r.decide_domenico).toBe(true)
    expect(r.bozza).toBe('non è json')
  })
  it('sicurezza e recesso non hanno mai bozza dal modello', () => {
    expect(interpretaRispostaAgente('{"famiglia":"sicurezza","bozza":"testo","decide_domenico":true}').bozza).toBeNull()
    expect(interpretaRispostaAgente('{"famiglia":"recesso","bozza":"inventato"}').bozza).toBeNull()
  })
  it('tutte le famiglie della specifica sono accettate', () => {
    for (const f of FAMIGLIE) {
      expect(interpretaRispostaAgente(`{"famiglia":"${f}"}`).famiglia).toBe(f)
    }
  })
})

describe('casi per famiglia: bozze attese passano la policy del canale', () => {
  const casi: { nome: string; kind: string; cliente: string; bozza: string }[] = [
    {
      nome: 'garanzia fuori termine (Amazon)',
      kind: 'amazon',
      cliente: 'Il frullatore ha smesso di funzionare dopo tre mesi, voglio la sostituzione.',
      bozza:
        'Buongiorno, il prodotto risulta coperto dalla garanzia legale. Per attivarla deve contattare il nostro centro assistenza al 071-2133550. Cordiali saluti.',
    },
    {
      nome: 'danneggiato (Amazon)',
      kind: 'amazon',
      cliente: 'Il pacco è arrivato con la scatola rotta e il prodotto danneggiato.',
      bozza:
        'Buongiorno, ci spiace per quanto accaduto.\n\nPer aprire la pratica con il corriere ci invii tre foto: il prodotto, l\'imballo esterno come arrivato e l\'etichetta di spedizione.',
    },
    {
      nome: 'giacenza BRT (Amazon)',
      kind: 'amazon',
      cliente: 'Dov\'è il mio pacco? Il corriere non è mai passato.',
      bozza:
        'Buongiorno, la spedizione risulta in giacenza: il corriere non ha trovato nessuno.\n\nMi indichi un numero di telefono e se desidera la consegna allo stesso indirizzo o a un altro, così faccio riconsegnare.',
    },
    {
      nome: 'fattura privato (Mirakl)',
      kind: 'mirakl',
      cliente: 'Vorrei la fattura per il mio ordine.',
      bozza:
        'Buongiorno, per i clienti privati non si emettono fatture, salvo detrazioni fiscali. Per la garanzia vale la conferma d\'ordine del marketplace.\n\nCordiali saluti.',
    },
  ]
  for (const c of casi) {
    it(c.nome, () => {
      expect(check(c.kind, c.bozza).ok).toBe(true)
      expect(c.bozza).not.toContain('—')
      expect(c.bozza).not.toMatch(/\{\{|\{[a-z_]+\}/)
    })
  }
})

describe('recesso: modello già pronto', () => {
  const modello =
    "Buongiorno {{cliente.nome}},\n\nabbiamo ricevuto la sua richiesta di recesso per l'ordine {{ordine.numero}}.\n\nIl costo della spedizione del reso è di € 6,00 e verrà trattenuto dal rimborso."
  it('compila nome e ordine, conserva il costo del modello', () => {
    const t = compilaModello(modello, { 'cliente.nome': 'Maria', 'ordine.numero': 'INSH1' })
    expect(t).toContain('Buongiorno Maria,')
    expect(t).toContain('INSH1')
    expect(t).toContain('€ 6,00')
  })
  it('nome mancante: saluto intatto, nessun segnaposto', () => {
    const t = compilaModello(modello, { 'ordine.numero': 'INSH1' })
    expect(t.startsWith('Buongiorno,')).toBe(true)
    expect(t).not.toContain('{{')
  })
  it('segnaposto ignoto: la riga sparisce', () => {
    const t = compilaModello('Ciao\n{{x.y}}\nFine', {})
    expect(t).toBe('Ciao\nFine')
  })
})

describe('esito senza draft_id', () => {
  const bozza = 'Buongiorno, la spedizione risulta in giacenza. Mi indichi un numero di telefono per la riconsegna.'
  it('identica: invariata', () => expect(esitoSenzaId(bozza, bozza)).toBe('usata_invariata'))
  it('ritoccata: modificata', () => {
    expect(esitoSenzaId(bozza, 'Buongiorno, la spedizione risulta in giacenza. Mi dia un numero di telefono per la riconsegna.')).toBe('usata_modificata')
  })
  it('scritta da zero: ignorata', () => {
    expect(esitoSenzaId(bozza, 'Rimborso emesso, lo riceverà tramite Amazon.')).toBe('ignorata')
    expect(somiglianza('a b c', '')).toBe(0)
  })
})
