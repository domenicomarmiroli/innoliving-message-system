import type { Config } from '../../config.js'
import type { Db } from '../../db/index.js'
import type { Logger } from '../../logger.js'
import { check as verificaPolicy, type EsitoPolicy } from '../policy.js'
import { creaProvider } from './provider.js'
import { redigi } from './redazione.js'

/**
 * Genera una proposta di risposta per un thread.
 *
 * Tre cose non negoziabili, in quest'ordine:
 *  1. Le note interne (message.interno = true) non entrano MAI nel
 *     contesto: possono contenere qualunque cosa un operatore abbia
 *     scritto pensando che restasse fra colleghi.
 *  2. Ogni messaggio del cliente passa da redigi() prima di finire nel
 *     prompt: IBAN, carte, codici fiscali oscurati — regola 8, qui non
 *     si tratta.
 *  3. Il testo che il modello propone NON è la risposta: è una
 *     proposta. Passa dallo stesso policy guard di un invio vero prima
 *     di tornare all'agente, così un problema si vede qui e non al
 *     momento di premere Invia.
 *
 * Il testo prodotto non viene MAI spedito da questa funzione: solo
 * salvato in ai_draft, per approvazione umana.
 */

const MAX_MESSAGGI_CONTESTO = 20
const MAX_TOKEN_RISPOSTA = 1000
const MAX_FONTI_KB = 5

export interface FonteKB {
  id: string
  titolo: string
  fonte: string
  url: string | null
}

export interface EsitoBozza {
  id: string
  testo: string
  modello: string
  policy: EsitoPolicy
  fonti: FonteKB[]
}

export async function generaBozza(
  db: Db,
  log: Logger,
  config: Config,
  threadId: string,
): Promise<EsitoBozza> {
  const [thread] = await db<
    {
      kind: string
      tags: string[]
      subject: string | null
      order_id: string | null
      customer_nome: string | null
      order_num: string | null
      order_tracking: string | null
      order_fulfillment: string | null
    }[]
  >`
    select
      ca.kind, t.tags, t.subject, t.order_id,
      cu.nome as customer_nome,
      coalesce(o.shopify_name, o.external_order_id) as order_num,
      o.tracking_number as order_tracking,
      o.fulfillment_status as order_fulfillment
    from thread t
    join channel_account ca on ca.id = t.account_id
    left join channel_identity ci on ci.id = t.identity_id
    left join customer cu on cu.id = ci.customer_id
    left join "order" o on o.id = t.order_id
    where t.id = ${threadId}
  `
  if (!thread) throw new Error(`Conversazione ${threadId} inesistente.`)

  // --- La cronologia, senza le note interne, redatta ------------------
  const messaggi = await db<{ direction: string; body_text: string | null; sent_at: Date }[]>`
    select direction, body_text, sent_at
    from message
    where thread_id = ${threadId} and interno = false and body_text is not null
    order by sent_at desc
    limit ${MAX_MESSAGGI_CONTESTO}
  `
  const cronologia = messaggi
    .reverse()
    .map((m) => {
      const chi = m.direction === 'in' ? 'Cliente' : 'Assistenza'
      return `${chi}: ${redigi(m.body_text ?? '').testo}`
    })
    .join('\n\n')

  // --- Knowledge base: solo ciò che condivide un tag col thread -------
  // Priorità prima di tutto: una procedura ("se il danno è segnalato,
  // chiedi sempre le foto") deve prevalere su una nota generica con lo
  // stesso tag, non essere scartata perché più vecchia.
  // Il filtro canali è lo stesso principio del reso Amazon-vs-Mirakl:
  // una voce senza canali selezionati (null o vuoto) vale per tutti, una
  // con canali valorizzati vale SOLO per quei kind di channel_account.
  const fonti = await db<
    { id: string; titolo: string; contenuto: string; fonte: string; url: string | null }[]
  >`
    select id, titolo, contenuto, fonte, url
    from knowledge
    where attivo = true
      and tag && ${thread.tags}
      and (canali is null or array_length(canali, 1) is null or ${thread.kind} = any(canali))
    order by priorita desc, created_at desc
    limit ${MAX_FONTI_KB}
  `

  const contestoOrdine = thread.order_id
    ? [
        thread.order_num ? `Numero ordine: ${thread.order_num}` : null,
        thread.order_fulfillment ? `Stato evasione: ${thread.order_fulfillment}` : null,
        thread.order_tracking ? `Tracking: ${thread.order_tracking}` : null,
      ]
        .filter(Boolean)
        .join('\n')
    : 'Nessun ordine collegato a questa conversazione.'

  const testoKB = fonti.length
    ? fonti
        .map((f) => {
          const riferimento = f.url ? `\nRiferimento (solo per il tuo contesto, non incollarlo nella risposta): ${f.url}` : ''
          return `[${f.titolo}]\n${f.contenuto}${riferimento}`
        })
        .join('\n\n---\n\n')
    : 'Nessuna voce della knowledge base è rilevante per questa conversazione.'

  const sistema = [
    'Sei un assistente che PROPONE risposte per un operatore del servizio clienti italiano.',
    'La tua proposta non viene mai inviata direttamente: un operatore la legge, la corregge se serve, e decide se mandarla.',
    'Scrivi in italiano, tono cortese e diretto, senza formule vuote.',
    'Usa SOLO le informazioni fornite qui sotto (ordine, cronologia, knowledge base). Se manca un dato per rispondere con certezza, dillo esplicitamente invece di inventarlo.',
    'Non includere mai IBAN, numeri di carta o dati di pagamento nella risposta, anche se il cliente li ha scritti.',
    'Non promettere rimborsi, sostituzioni o azioni specifiche a meno che la knowledge base o il contesto ordine non le confermino esplicitamente.',
    'Alcune fonti della knowledge base includono un link di riferimento alle linee guida ufficiali di un marketplace: è per il tuo contesto, non copiarlo mai nella risposta a meno che non sia specificamente richiesto e utile al cliente.',
  ].join(' ')

  const utente = [
    `Contesto ordine:\n${contestoOrdine}`,
    `Knowledge base rilevante:\n${testoKB}`,
    `Conversazione finora:\n${cronologia || '(nessun messaggio precedente)'}`,
    'Proponi la prossima risposta dell\'assistenza, solo il testo del messaggio.',
  ].join('\n\n')

  const provider = await creaProvider(config)
  const completamento = await provider.completa({
    sistema,
    utente,
    max_token: MAX_TOKEN_RISPOSTA,
  })

  const policy = verificaPolicy(thread.kind, completamento.testo)

  const [riga] = await db<{ id: string }[]>`
    insert into ai_draft (thread_id, model, prompt_version, draft_text, policy_check, fonti)
    values (
      ${threadId}, ${completamento.modello}, 'v1', ${completamento.testo},
      ${db.json({ ok: policy.ok, violazioni: policy.violazioni } as never)},
      ${db.json(fonti.map((f) => ({ id: f.id, titolo: f.titolo, fonte: f.fonte })) as never)}
    )
    returning id
  `

  log.info(
    { thread_id: threadId, modello: completamento.modello, fonti: fonti.length, policy_ok: policy.ok },
    'bozza AI generata',
  )

  return {
    id: riga!.id,
    testo: completamento.testo,
    modello: completamento.modello,
    policy,
    fonti: fonti.map((f) => ({ id: f.id, titolo: f.titolo, fonte: f.fonte, url: f.url })),
  }
}
