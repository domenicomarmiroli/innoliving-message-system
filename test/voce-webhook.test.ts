import { describe, it, expect } from 'vitest'
import { createHmac } from 'node:crypto'
import { estraiChiamata, verificaFirmaElevenLabs } from '../src/core/voce/fine-chiamata.js'

const segreto = 'wsec_prova_prova_prova'
const firma = (t: number, corpo: string, s = segreto) =>
  `t=${t},v0=${createHmac('sha256', s).update(`${t}.${corpo}`).digest('hex')}`

describe('verificaFirmaElevenLabs', () => {
  const ora = 1_791_300_000_000
  const t = Math.floor(ora / 1000)
  const corpo = '{"type":"post_call_transcription"}'
  it('accetta la firma calcolata come l\u2019SDK ufficiale', () => {
    expect(verificaFirmaElevenLabs(firma(t, corpo), Buffer.from(corpo), segreto, ora)).toBe(true)
  })
  it('rifiuta corpo alterato, secret sbagliato, firma vecchia o assente', () => {
    expect(verificaFirmaElevenLabs(firma(t, corpo), Buffer.from(corpo + ' '), segreto, ora)).toBe(false)
    expect(verificaFirmaElevenLabs(firma(t, corpo, 'altro_segreto_lungo'), Buffer.from(corpo), segreto, ora)).toBe(false)
    expect(verificaFirmaElevenLabs(firma(t - 31 * 60, corpo), Buffer.from(corpo), segreto, ora)).toBe(false)
    expect(verificaFirmaElevenLabs(undefined, Buffer.from(corpo), segreto, ora)).toBe(false)
  })
})

describe('estraiChiamata', () => {
  it('dalla forma documentata ai dati del popup', () => {
    const c = estraiChiamata({
      type: 'post_call_transcription',
      event_timestamp: 1791300000,
      data: {
        agent_id: 'agent_x',
        conversation_id: 'conv_1',
        transcript: [
          { role: 'agent', message: 'Buongiorno, come posso aiutarla?', time_in_call_secs: 0 },
          { role: 'user', message: 'Non mi è arrivato il pacco.', time_in_call_secs: 4 },
          { role: 'agent', message: null, tool_calls: [{}], time_in_call_secs: 9 },
        ],
        metadata: {
          start_time_unix_secs: 1791299900,
          call_duration_secs: 95,
          cost: 915,
          charging: { call_charge: 572, llm_charge: 343, platform_price: 0.0567, llm_price: 0.0342, dev_discount: true },
        },
        analysis: { call_successful: 'success', transcript_summary: 'Rimborso già emesso.' },
      },
    })
    expect(c).toMatchObject({
      conversation_id: 'conv_1', esito: 'success', durata_secondi: 95, riassunto: 'Rimborso già emesso.',
      costo_crediti: 915, crediti_voce: 572, crediti_llm: 343, chiamata_test: true,
    })
    expect(c?.costo_usd).toBeCloseTo(0.0909, 4)
    expect(c?.trascrizione).toEqual([
      { ruolo: 'agente', testo: 'Buongiorno, come posso aiutarla?', secondo: 0 },
      { ruolo: 'cliente', testo: 'Non mi è arrivato il pacco.', secondo: 4 },
    ])
  })
  it('audio e chiamate non riuscite si ignorano', () => {
    expect(estraiChiamata({ type: 'post_call_audio', data: { conversation_id: 'c' } })).toBeNull()
    expect(estraiChiamata({ type: 'call_initiation_failure', data: { conversation_id: 'c' } })).toBeNull()
  })
})

describe('notaChiamata', () => {
  it("inizia con lo stesso prefisso delle note dell'agente, che l'interfaccia riconosce", async () => {
    const { notaChiamata } = await import('../src/core/voce/fine-chiamata.js')
    expect(notaChiamata(104)).toBe("Il cliente ha chiamato l'assistente vocale. Durata 1:44. Nessuna nuova richiesta lasciata: la trascrizione è disponibile.")
    expect(notaChiamata(null).startsWith("Il cliente ha chiamato l'assistente vocale.")).toBe(true)
  })
})

describe('senzaTagVoce', () => {
  it('toglie i tag di tono ma non il testo né i segnaposto in maiuscolo', async () => {
    const { senzaTagVoce } = await import('../src/core/voce/fine-chiamata.js')
    expect(senzaTagVoce('[professional] Buongiorno, sono Sabrina.')).toBe('Buongiorno, sono Sabrina.')
    expect(senzaTagVoce('[warm] Grazie Stefania. [reassuring] Il rimborso è stato emesso.')).toBe('Grazie Stefania. Il rimborso è stato emesso.')
    expect(senzaTagVoce('Dato [DA VERIFICARE] da controllare')).toBe('Dato [DA VERIFICARE] da controllare')
  })
})
