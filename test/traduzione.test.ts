import { describe, it, expect } from 'vitest'
import type { ProviderAI, RichiestaCompletamento } from '../src/core/ai/provider.js'
import { proteggi } from '../src/core/ai/redazione.js'
import {
  interpretaRilevamento,
  nomeLingua,
  rilevaETraduci,
  traduciMessaggiInArrivo,
  traduciPerCliente,
  azzeraTentativiTraduzione,
} from '../src/core/ai/traduzione.js'
import { parseConfig } from '../src/config.js'
import type { Db } from '../src/db/index.js'

/** Un provider finto: registra cosa riceve, risponde con ciò che gli si dice. */
function providerFinto(risposta: (r: RichiestaCompletamento) => string) {
  const ricevute: RichiestaCompletamento[] = []
  const provider: ProviderAI = {
    nome: 'finto',
    async completa(r) {
      ricevute.push(r)
      return { testo: risposta(r), modello: 'finto' }
    },
  }
  return { provider, ricevute }
}

describe('interpretaRilevamento', () => {
  it('legge lingua e traduzione', () => {
    expect(interpretaRilevamento('{"lingua":"de","traduzione":"Dov\'è il mio pacco?"}')).toEqual({
      lingua: 'de',
      traduzione: "Dov'è il mio pacco?",
    })
  })

  it('tollera testo attorno al JSON', () => {
    expect(interpretaRilevamento('Ecco: {"lingua":"FR","traduzione":"Grazie"} fine')).toEqual({
      lingua: 'fr',
      traduzione: 'Grazie',
    })
  })

  it("un messaggio in italiano non ha traduzione", () => {
    expect(interpretaRilevamento('{"lingua":"it","traduzione":null}')).toEqual({
      lingua: 'it',
      traduzione: null,
    })
  })

  it('meglio null che un dato sbagliato salvato per sempre', () => {
    expect(interpretaRilevamento('non è json')).toBeNull()
    expect(interpretaRilevamento('{"lingua":"tedesco","traduzione":"x"}')).toBeNull()
    expect(interpretaRilevamento('{"lingua":"de","traduzione":""}')).toBeNull()
    expect(interpretaRilevamento('{"lingua":"de"}')).toBeNull()
  })
})

describe('messaggi in arrivo: niente dati personali nel prompt (regola 8)', () => {
  it("l'IBAN del cliente non arriva al modello", async () => {
    const { provider, ricevute } = providerFinto(() => '{"lingua":"de","traduzione":"Rimborsatemi"}')
    await rilevaETraduci(provider, 'Bitte erstatten Sie auf IT60X0542811101000000123456')
    expect(ricevute[0]!.utente).not.toContain('IT60X0542811101000000123456')
    expect(ricevute[0]!.utente).toContain('[IBAN oscurato]')
  })
})

describe('proteggi — oscuramento reversibile', () => {
  it('sostituisce i dati con segnaposti numerati e li rimette', () => {
    const p = proteggi('Accrediteremo su IT60X0542811101000000123456 entro 5 giorni.')
    expect(p.segnaposti).toBe(1)
    expect(p.testo).toBe('Accrediteremo su ⟦1⟧ entro 5 giorni.')
    expect(p.ripristina('Wir überweisen auf ⟦1⟧ innerhalb von 5 Tagen.')).toBe(
      'Wir überweisen auf IT60X0542811101000000123456 innerhalb von 5 Tagen.',
    )
  })

  it('un numero d ordine Amazon non è un dato da proteggere', () => {
    const p = proteggi('Il suo ordine 407-6403985-4699551 è partito.')
    expect(p.segnaposti).toBe(0)
    expect(p.testo).toBe('Il suo ordine 407-6403985-4699551 è partito.')
  })

  it('se la traduzione perde il segnaposto, lancia invece di spedire un testo mutilato', () => {
    const p = proteggi('IBAN: IT60X0542811101000000123456')
    expect(() => p.ripristina('IBAN: (rimosso)')).toThrow(/perso/)
  })

  it('se lo duplica, lancia: il dato giusto nel punto sbagliato è peggio', () => {
    const p = proteggi('IBAN: IT60X0542811101000000123456')
    expect(() => p.ripristina('⟦1⟧ e ancora ⟦1⟧')).toThrow(/duplicato/)
  })
})

describe('traduciPerCliente', () => {
  it('il modello non vede il dato, il cliente sì', async () => {
    const { provider, ricevute } = providerFinto((r) =>
      r.utente.replace('Accrediteremo su', 'Nous créditerons'),
    )
    const tradotto = await traduciPerCliente(
      provider,
      'Accrediteremo su IT60X0542811101000000123456 entro 5 giorni.',
      'fr',
    )
    expect(ricevute[0]!.utente).not.toContain('IT60X0542811101000000123456')
    expect(ricevute[0]!.sistema).toContain('francese')
    expect(tradotto).toContain('IT60X0542811101000000123456')
    expect(tradotto).toContain('Nous créditerons')
  })

  it('una traduzione vuota è un errore, non un messaggio vuoto da spedire', async () => {
    const { provider } = providerFinto(() => '   ')
    await expect(traduciPerCliente(provider, 'Buongiorno', 'de')).rejects.toThrow(/vuota/)
  })
})

describe('nomeLingua', () => {
  it('dà un nome leggibile alle lingue comuni e lascia il codice per le altre', () => {
    expect(nomeLingua('de')).toBe('tedesco')
    expect(nomeLingua('fr')).toBe('francese')
    expect(nomeLingua('fi')).toBe('fi')
  })
})

describe('costo sotto controllo (caso reale 02-07/10)', () => {
  it('un testo lungo viene tagliato prima di arrivare al modello', async () => {
    const { provider, ricevute } = providerFinto(() => '{"lingua":"en","traduzione":"x"}')
    await rilevaETraduci(provider, 'a '.repeat(10_000))
    expect(ricevute[0]!.utente.length).toBeLessThanOrEqual(4000)
  })

  it('un messaggio che fallisce due volte non viene più ripagato a ogni giro', async () => {
    azzeraTentativiTraduzione()
    const config = parseConfig({ SUPABASE_DB_URL: 'postgres://prova', ANTHROPIC_API_KEY: 'chiave-di-prova' })
    if (!config.success) throw new Error('config')
    const fn = (strings: TemplateStringsArray) =>
      Promise.resolve(strings.join('?').includes('from message') ? [{ id: 'm1', body_text: 'Hello' }] : [])
    const db = Object.assign(fn, { json: (x: unknown) => x }) as unknown as Db
    const log = { info() {}, warn() {}, error() {}, debug() {} }

    let chiamate = 0
    const originale = globalThis.fetch
    globalThis.fetch = (async () => {
      chiamate += 1
      // Risposta troncata: JSON mai chiuso, come quando si superano i token.
      return new Response(JSON.stringify({ content: [{ type: 'text', text: '{"lingua":"en","traduzione":"Ciao' }], model: 'x' }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })
    }) as typeof fetch
    try {
      for (let giro = 0; giro < 5; giro++) await traduciMessaggiInArrivo(db, log, config.data)
    } finally {
      globalThis.fetch = originale
    }
    expect(chiamate).toBe(2)
  })
})
