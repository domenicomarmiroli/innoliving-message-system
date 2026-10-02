import type { Config } from '../../config.js'
import type { Db } from '../../db/index.js'
import type { Logger } from '../../logger.js'
import { creaProvider, type ProviderAI } from './provider.js'
import { proteggi, redigi } from './redazione.js'

/**
 * Traduzione dei messaggi, nei due sensi.
 *
 * - **In arrivo**: ogni messaggio del cliente viene esaminato; se non è
 *   in italiano se ne salva la traduzione in `message.body_text_it`.
 *   Modello economico (`ANTHROPIC_MODEL_CLASSIFICAZIONE`): serve a
 *   capire, non a scrivere, e gira su ogni messaggio.
 * - **In uscita**: l'operatore scrive in italiano, questa funzione
 *   produce la versione nella lingua del cliente. Modello delle bozze
 *   (`ANTHROPIC_MODEL`): questo testo lo legge il cliente, e la qualità
 *   conta più del costo. **Non spedisce niente**: la traduzione torna
 *   all'interfaccia come anteprima, e parte solo ciò che l'operatore ha
 *   visto.
 *
 * Regola 8 in entrambi i sensi: nessun IBAN, carta o codice fiscale
 * entra in un prompt. In arrivo con `redigi()` (la traduzione è da
 * leggere, l'originale resta visibile); in uscita con `proteggi()`,
 * reversibile, perché il dato deve arrivare al cliente.
 */

/** Le lingue con un nome leggibile; qualunque altro codice ISO resta valido. */
export const NOMI_LINGUA: Record<string, string> = {
  it: 'italiano',
  en: 'inglese',
  de: 'tedesco',
  fr: 'francese',
  es: 'spagnolo',
  pt: 'portoghese',
  nl: 'olandese',
  pl: 'polacco',
  sv: 'svedese',
  da: 'danese',
  cs: 'ceco',
  ro: 'rumeno',
  el: 'greco',
  tr: 'turco',
}

export function nomeLingua(codice: string): string {
  return NOMI_LINGUA[codice] ?? codice
}

/** Oltre questa lunghezza si traduce l'inizio: un messaggio di assistenza non è un romanzo. */
const MAX_CARATTERI_INGRESSO = 8000
const MAX_TOKEN_TRADUZIONE = 2500

export interface Rilevamento {
  lingua: string
  /** Null quando il testo è già in italiano. */
  traduzione: string | null
}

/**
 * Legge la risposta del modello. Pura e difensiva come
 * `interpretaRisposta()` dell'intento: il modello può aggiungere testo
 * attorno al JSON, sbagliare il codice lingua, o restituire una
 * traduzione vuota — in tutti quei casi meglio null (e un nuovo
 * tentativo al giro dopo) che un dato sbagliato salvato per sempre.
 */
export function interpretaRilevamento(risposta: string): Rilevamento | null {
  const inizio = risposta.indexOf('{')
  const fine = risposta.lastIndexOf('}')
  if (inizio < 0 || fine <= inizio) return null

  let dati: unknown
  try {
    dati = JSON.parse(risposta.slice(inizio, fine + 1))
  } catch {
    return null
  }
  if (!dati || typeof dati !== 'object') return null

  const { lingua, traduzione } = dati as { lingua?: unknown; traduzione?: unknown }
  if (typeof lingua !== 'string') return null
  const codice = lingua.trim().toLowerCase()
  if (!/^[a-z]{2}$/.test(codice)) return null

  if (codice === 'it') return { lingua: 'it', traduzione: null }
  if (typeof traduzione !== 'string' || traduzione.trim() === '') return null
  return { lingua: codice, traduzione: traduzione.trim() }
}

const SISTEMA_RILEVAMENTO = [
  "Ricevi il testo di un messaggio che un cliente ha scritto al servizio clienti di un'azienda italiana.",
  'Individua la lingua in cui è scritto e, se NON è italiano, traducilo in italiano.',
  'Traduci fedelmente: non riassumere, non correggere, non aggiungere niente. Mantieni a capo, numeri, codici d\'ordine e nomi di prodotto così come sono.',
  'Le parti fra parentesi quadre tipo "[IBAN oscurato]" lasciale invariate.',
  'Se il messaggio mescola più lingue, scegli quella prevalente.',
  'Rispondi SOLO con un oggetto JSON, nient\'altro:',
  '{"lingua": "<codice ISO 639-1 di due lettere>", "traduzione": "<testo in italiano, o null se il messaggio è già in italiano>"}',
].join('\n')

export async function rilevaETraduci(provider: ProviderAI, testo: string): Promise<Rilevamento | null> {
  const pulito = redigi(testo.slice(0, MAX_CARATTERI_INGRESSO)).testo
  const esito = await provider.completa({
    sistema: SISTEMA_RILEVAMENTO,
    utente: pulito,
    max_token: MAX_TOKEN_TRADUZIONE,
  })
  return interpretaRilevamento(esito.testo)
}

function sistemaVersoCliente(lingua: string): string {
  return [
    `Traduci in ${nomeLingua(lingua)} (codice ${lingua}) la risposta che un operatore del servizio clienti ha scritto in italiano per un cliente.`,
    'È un messaggio che il cliente riceverà così com\'è: tono cortese e naturale per un madrelingua, registro formale (dare del Lei / vous / Sie dove la lingua lo prevede).',
    'Traduci tutto e solo il testo: niente premesse, niente note, niente virgolette attorno, niente firme aggiunte.',
    'Mantieni a capo, elenchi, numeri d\'ordine, codici di tracciamento, importi, link e nomi di prodotto esattamente come sono.',
    'I segnaposto come ⟦1⟧ o ⟦2⟧ vanno lasciati IDENTICI e nello stesso punto della frase: sostituiscono dati che verranno reinseriti dopo.',
  ].join('\n')
}

/**
 * Traduce una nostra risposta nella lingua del cliente. Lancia se il
 * modello perde un segnaposto (vedi `proteggi()`): l'interfaccia mostra
 * l'errore e l'operatore riprova, invece di spedire un testo mutilato.
 */
export async function traduciPerCliente(
  provider: ProviderAI,
  testoItaliano: string,
  lingua: string,
): Promise<string> {
  const protetto = proteggi(testoItaliano)
  const esito = await provider.completa({
    sistema: sistemaVersoCliente(lingua),
    utente: protetto.testo,
    max_token: MAX_TOKEN_TRADUZIONE,
  })
  const tradotto = esito.testo.trim()
  if (!tradotto) throw new Error('Il modello ha restituito una traduzione vuota: riprova.')
  return protetto.ripristina(tradotto)
}

// ---------------------------------------------------------------------
// Messaggi in arrivo: il giro periodico
// ---------------------------------------------------------------------

/**
 * Esamina i messaggi dei clienti non ancora esaminati (`lingua is null`)
 * e ne salva lingua e, se serve, traduzione.
 *
 * **Un giro periodico invece di un passaggio dentro ogni connettore**:
 * email Gmail, casella Microsoft, Mirakl e form dei siti scrivono tutti
 * nella stessa tabella, e da qui li copre tutti senza toccare nessuna
 * ingestione. Un fallimento (modello che non risponde, JSON storto)
 * lascia la riga com'era e si riprova al giro dopo — stessa idea di
 * `riaggancia.ts`.
 *
 * Limiti: finestra di 7 giorni (non si ritraduce lo storico, e una riga
 * che fallisce sempre non viene ritentata in eterno) e massimo 20
 * messaggi per giro.
 */
const GIORNI_FINESTRA = 7
const PER_GIRO = 20

export async function traduciMessaggiInArrivo(db: Db, log: Logger, config: Config): Promise<number> {
  if (!config.ANTHROPIC_API_KEY) return 0

  const righe = await db<{ id: string; body_text: string }[]>`
    select id, body_text
    from message
    where direction = 'in'
      and author_kind = 'customer'
      and lingua is null
      and body_text is not null
      and length(trim(body_text)) > 0
      and created_at > now() - ${`${GIORNI_FINESTRA} days`}::interval
    order by created_at desc
    limit ${PER_GIRO}
  `
  if (righe.length === 0) return 0

  const provider = await creaProvider(config, config.ANTHROPIC_MODEL_CLASSIFICAZIONE)
  let tradotti = 0

  for (const r of righe) {
    try {
      const esito = await rilevaETraduci(provider, r.body_text)
      if (!esito) {
        log.warn({ message_id: r.id }, 'traduzione: risposta del modello non interpretabile, riprovo al giro dopo')
        continue
      }
      await db`
        update message
        set lingua = ${esito.lingua}, body_text_it = ${esito.traduzione}
        where id = ${r.id}
      `
      if (esito.traduzione) tradotti += 1
    } catch (errore) {
      log.warn(
        { message_id: r.id, err: errore instanceof Error ? errore.message : String(errore) },
        'traduzione di un messaggio in arrivo non riuscita, riprovo al giro dopo',
      )
    }
  }

  return tradotti
}

/**
 * La lingua del cliente di un thread: quella del suo ultimo messaggio già
 * esaminato. Null se non lo sappiamo ancora (messaggio appena arrivato,
 * non ancora passato dal giro) — in quel caso l'interfaccia non propone
 * la traduzione, e l'operatore può comunque scegliere la lingua a mano.
 */
export async function linguaClienteDelThread(db: Db, threadId: string): Promise<string | null> {
  const [riga] = await db<{ lingua: string }[]>`
    select lingua from message
    where thread_id = ${threadId}
      and direction = 'in' and author_kind = 'customer'
      and lingua is not null
    order by sent_at desc
    limit 1
  `
  return riga?.lingua ?? null
}
