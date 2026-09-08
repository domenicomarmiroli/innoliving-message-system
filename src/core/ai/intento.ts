import type { Config } from '../../config.js'
import type { Db } from '../../db/index.js'
import type { Logger } from '../../logger.js'
import { creaProvider } from './provider.js'
import { redigi } from './redazione.js'

/**
 * Classificazione automatica dell'intento di un ticket — passo 07 del
 * runbook, mai partito prima d'ora: verificato sui dati reali che 1.654
 * thread su 1.744 (95%, 03/09) non avevano nessun tag, e che
 * `generaBozza()` (`core/ai/draft.ts`) recupera dalla knowledge base solo
 * quando `thread.tags` e `knowledge.tag` condividono un valore — senza
 * tag, la knowledge base non contribuisce mai.
 *
 * Le categorie si scrivono nella STESSA colonna `thread.tags` già
 * esistente, non in una colonna nuova: la knowledge base, la dashboard
 * (`v_tag_giornalieri`) e i tag dell'interfaccia Lovable iniziano a
 * funzionare per questi ticket senza nessuna modifica altrove.
 *
 * Lista chiusa, non testo libero: le 8 voci reali della knowledge base
 * avevano tag scritti a mano, incoerenti (tre varianti diverse per
 * "prodotto danneggiato" sulla stessa voce) — un confronto esatto fra
 * tag non può funzionare senza un vocabolario comune.
 */

export const CATEGORIE_INTENTO = [
  'reso',
  'rimborso',
  'garanzia',
  'prodotto-danneggiato',
  'prodotto-difettoso',
  'spedizione-ritardo',
  'spedizione-tracking',
  'ordine-modifica',
  'fattura',
  'domanda-prodotto',
  'reclamo',
  'pezzi-di-ricambio',
  'altro',
] as const

export type CategoriaIntento = (typeof CATEGORIE_INTENTO)[number]

const DESCRIZIONI: Record<CategoriaIntento, string> = {
  reso: 'il cliente vuole restituire il prodotto o chiede come farlo',
  rimborso: 'il cliente chiede un rimborso o informazioni su un rimborso in corso',
  garanzia: 'riparazione o sostituzione in garanzia di un prodotto guasto',
  'prodotto-danneggiato': 'il prodotto è arrivato rotto o danneggiato dal trasporto',
  'prodotto-difettoso': 'il prodotto non funziona o è difettoso, non per danno da trasporto',
  'spedizione-ritardo': 'il cliente chiede dov\'è il suo ordine o segnala un ritardo nella consegna',
  'spedizione-tracking': 'domanda sul tracking o sul corriere, senza necessariamente un ritardo',
  'ordine-modifica': 'cambio indirizzo, cambio articolo, o annullamento di un ordine non ancora spedito',
  fattura: 'richiesta di fattura o di un documento fiscale',
  'domanda-prodotto': 'domanda su uso, compatibilità o caratteristiche di un prodotto, prima o dopo l\'acquisto',
  reclamo: 'insoddisfazione o lamentela generica che non rientra nelle categorie sopra',
  'pezzi-di-ricambio': 'richiesta di un pezzo di ricambio',
  altro: 'nessuna delle categorie sopra descrive con sicurezza il messaggio',
}

const MAX_TOKEN_RISPOSTA = 30
const MAX_CATEGORIE = 2

/**
 * Interpreta la risposta grezza del modello: whitelist contro
 * {@link CATEGORIE_INTENTO}, non fiducia nel testo libero che il modello
 * potrebbe restituire. Funzione pura, testabile senza rete — stesso
 * principio di `calcolaEsito()` in `core/ai/esito.ts`.
 */
export function interpretaRisposta(testoModello: string): CategoriaIntento[] {
  const insieme = new Set<CategoriaIntento>()
  for (const pezzo of testoModello.split(/[,\n]/)) {
    const candidato = pezzo.trim().toLowerCase()
    if ((CATEGORIE_INTENTO as readonly string[]).includes(candidato)) {
      insieme.add(candidato as CategoriaIntento)
    }
    if (insieme.size >= MAX_CATEGORIE) break
  }
  return insieme.size > 0 ? [...insieme] : ['altro']
}

/**
 * Chiama il modello per classificare un messaggio. Applica `redigi()`
 * PRIMA di costruire il prompt — regola 8, stessa disciplina di
 * `generaBozza()` — e usa un modello economico dedicato
 * (`ANTHROPIC_MODEL_CLASSIFICAZIONE`), non quello delle bozze: gira su
 * ogni ticket nuovo, molto più spesso di una bozza attivata a mano.
 */
export async function classificaIntento(
  config: Config,
  testo: string,
): Promise<CategoriaIntento[]> {
  const elenco = CATEGORIE_INTENTO.map((c) => `- ${c}: ${DESCRIZIONI[c]}`).join('\n')
  const sistema = [
    'Classifichi messaggi di assistenza clienti e-commerce in categorie fisse.',
    'Il messaggio può essere in lingue diverse dall\'italiano (francese, tedesco, inglese...): classificalo comunque.',
    'Rispondi SOLO con 1 o al massimo 2 nomi di categoria fra questi, separati da virgola, senza altro testo:',
    elenco,
  ].join('\n')

  const provider = await creaProvider(config, config.ANTHROPIC_MODEL_CLASSIFICAZIONE)
  const completamento = await provider.completa({
    sistema,
    utente: redigi(testo).testo,
    max_token: MAX_TOKEN_RISPOSTA,
  })

  return interpretaRisposta(completamento.testo)
}

/**
 * Il punto d'ingresso per i connettori: classifica e scrive le categorie
 * su `thread.tags`, unendole a quelle già presenti senza duplicati — non
 * tocca mai un tag già scritto da altro (es. `reso-richiesto` di un
 * evento automatico). Non lancia mai un'eccezione: un fallimento di
 * classificazione finisce in un avviso di log, il ticket resta senza tag
 * automatico ma non si perde — stessa filosofia di un allegato che non
 * carica.
 */
export async function classificaEsalvaIntento(
  db: Db,
  log: Logger,
  config: Config,
  threadId: string,
  testo: string | null,
): Promise<void> {
  if (!testo || !testo.trim()) return

  try {
    const categorie = await classificaIntento(config, testo)
    await db`
      update thread
      set tags = (select array(select distinct unnest(tags || ${categorie}))),
          updated_at = now()
      where id = ${threadId}
    `
    log.info({ thread_id: threadId, categorie }, 'intento del ticket classificato')
  } catch (errore) {
    log.warn(
      { thread_id: threadId, err: errore instanceof Error ? errore.message : String(errore) },
      'classificazione intento fallita: il ticket resta senza tag automatico',
    )
  }
}
