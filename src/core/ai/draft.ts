import type { Config } from '../../config.js'
import type { Db } from '../../db/index.js'
import type { Logger } from '../../logger.js'
import { check as verificaPolicy, type EsitoPolicy } from '../policy.js'
import { caricaDatiOrdine, formattaContestoOrdine } from './bozza-contesto.js'
import {
  PARAMETRI_NEUTRI,
  PROMPT_VERSION,
  type ParametriAzienda,
  compilaModello,
  costruisciSistema,
  interpretaRispostaAgente,
  type AzioneConsigliata,
  type Famiglia,
} from './bozza-prompt.js'
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
 *     prompt: IBAN, carte, codici fiscali oscurati (regola 8).
 *  3. Il testo che il modello propone NON è la risposta: è una
 *     proposta. Passa dallo stesso policy guard di un invio vero prima
 *     di tornare all'agente.
 *
 * Il prompt (bozza-prompt.ts) nasce dalla specifica "istruzioni agente
 * bozze" del 2026-11-04. L'output ha due parti: il testo per il cliente
 * e l'azione consigliata per l'operatore, che il sistema non esegue mai.
 *
 * Il testo prodotto non viene MAI spedito da questa funzione: solo
 * salvato in ai_draft, per approvazione umana.
 */

const MAX_MESSAGGI_CONTESTO = 20
const MAX_TOKEN_RISPOSTA = 1500
const MAX_FONTI_KB = 5

export interface FonteKB {
  id: string
  titolo: string
  fonte: string
  url: string | null
}

export interface EsitoBozza {
  id: string
  /** Testo per il cliente. Vuoto quando l'agente non propone nulla. */
  testo: string
  famiglia: Famiglia
  /** Azione consigliata, separata dal testo: il sistema non la esegue mai. */
  azione: AzioneConsigliata
  nota_operatore: string | null
  decide_domenico: boolean
  modello: string
  policy: EsitoPolicy
  fonti: FonteKB[]
}

export async function generaBozza(
  db: Db,
  log: Logger,
  config: Config,
  threadId: string,
  opzioni: { sfondo?: boolean } = {},
): Promise<EsitoBozza> {
  const [thread] = await db<
    { kind: string; account_code: string; tags: string[]; customer_nome: string | null }[]
  >`
    select ca.kind, ca.code as account_code, t.tags, cu.nome as customer_nome
    from thread t
    join channel_account ca on ca.id = t.account_id
    left join channel_identity ci on ci.id = t.identity_id
    left join customer cu on cu.id = ci.customer_id
    where t.id = ${threadId}
  `
  if (!thread) throw new Error(`Conversazione ${threadId} inesistente.`)

  // --- La cronologia, senza le note interne, redatta ------------------
  const messaggi = await db<
    { id: string; direction: string; author_kind: string | null; body_text: string | null; sent_at: Date }[]
  >`
    select id, direction, author_kind, body_text, sent_at
    from message
    where thread_id = ${threadId} and interno = false and body_text is not null
    order by sent_at desc
    limit ${MAX_MESSAGGI_CONTESTO}
  `
  const ordinati = messaggi.reverse()
  const ultimoCliente = [...ordinati].reverse().find((m) => m.direction === 'in' && m.author_kind === 'customer')
  const cronologia = ordinati
    .map((m) => {
      const chi =
        m.direction === 'out' ? 'Assistenza' : m.author_kind === 'customer' ? 'Cliente' : 'Notifica automatica'
      return `${chi}: ${redigi(m.body_text ?? '').testo}`
    })
    .join('\n\n')

  // --- Knowledge base: ciò che condivide un tag col thread ------------
  // Priorità prima di tutto: una procedura deve prevalere su una nota
  // generica con lo stesso tag. Il filtro canali confronta
  // channel_account.code, non kind (due operatori Mirakl possono avere
  // logiche diverse). Senza canali = vale per tutti.
  const fonti = await db<
    { id: string; titolo: string; contenuto: string; fonte: string; url: string | null }[]
  >`
    select id, titolo, contenuto, fonte, url
    from knowledge
    where attivo = true
      and tag && ${thread.tags}
      and (canali is null or array_length(canali, 1) is null or ${thread.account_code} = any(canali))
    order by priorita desc, created_at desc
    limit ${MAX_FONTI_KB}
  `

  const datiOrdine = await caricaDatiOrdine(db, config, threadId)
  const contestoOrdine = formattaContestoOrdine(datiOrdine)

  const testoKB = fonti.length
    ? fonti
        .map((f) => {
          const riferimento = f.url ? `\nRiferimento (solo per il tuo contesto, non incollarlo nella risposta): ${f.url}` : ''
          return `[${f.titolo}]\n${f.contenuto}${riferimento}`
        })
        .join('\n\n---\n\n')
    : 'Nessuna voce della knowledge base è rilevante per questa conversazione.'

  const [cfg] = await db<{ value: Partial<ParametriAzienda> | null }[]>`
    select value from app_config where key = 'bozze_agente'
  `
  const sistema = costruisciSistema({ ...PARAMETRI_NEUTRI, ...(cfg?.value ?? {}) })
  const utente = [
    `Dati dell'ordine:\n${contestoOrdine}`,
    `Knowledge base rilevante (la specifica nelle istruzioni prevale in caso di contrasto):\n${testoKB}`,
    `Conversazione finora:\n${cronologia || '(nessun messaggio precedente)'}`,
    "Classifica dal testo dell'ultimo messaggio del cliente, poi rispondi con il JSON richiesto.",
  ].join('\n\n')

  const provider = await creaProvider(config, undefined, {
    funzione: 'bozza',
    sfondo: opzioni.sfondo ?? false,
  })
  const completamento = await provider.completa({ sistema, utente, max_token: MAX_TOKEN_RISPOSTA })
  const risposta = interpretaRispostaAgente(completamento.testo)

  // Recesso: il testo è il modello già pronto della tabella `template`
  // (costo della spedizione di reso incluso), mai riscritto dal modello.
  let testoBozza = risposta.bozza
  if (risposta.famiglia === 'recesso') {
    const [modello] = await db<{ body_tpl: string | null }[]>`
      select body_tpl from template where name = 'Reso Recesso' and locale = 'it' limit 1
    `
    if (modello?.body_tpl) {
      testoBozza = compilaModello(modello.body_tpl, {
        'cliente.nome': thread.customer_nome?.trim().split(/\s+/)[0] ?? null,
        'ordine.numero': datiOrdine?.numero ?? null,
      })
    } else {
      risposta.nota_operatore = [
        risposta.nota_operatore,
        'Modello "Reso Recesso" non trovato nei template: scrivi il testo a mano.',
      ]
        .filter(Boolean)
        .join(' ')
    }
  }

  // La policy guarda il testo per il cliente, mai la nota all'operatore.
  const policy: EsitoPolicy = testoBozza ? verificaPolicy(thread.kind, testoBozza) : { ok: true, violazioni: [] }

  const [riga] = await db<{ id: string }[]>`
    insert into ai_draft (
      thread_id, model, prompt_version, draft_text, policy_check, fonti,
      famiglia, azione, nota_operatore, decide_domenico, trigger_message_id
    )
    values (
      ${threadId}, ${completamento.modello}, ${PROMPT_VERSION}, ${testoBozza ?? ''},
      ${db.json({ ok: policy.ok, violazioni: policy.violazioni } as never)},
      ${db.json(fonti.map((f) => ({ id: f.id, titolo: f.titolo, fonte: f.fonte })) as never)},
      ${risposta.famiglia}, ${db.json(risposta.azione as never)}, ${risposta.nota_operatore},
      ${risposta.decide_domenico}, ${ultimoCliente?.id ?? null}
    )
    returning id
  `

  log.info(
    {
      thread_id: threadId,
      modello: completamento.modello,
      famiglia: risposta.famiglia,
      fonti: fonti.length,
      policy_ok: policy.ok,
    },
    'bozza AI generata',
  )

  return {
    id: riga!.id,
    testo: testoBozza ?? '',
    famiglia: risposta.famiglia,
    azione: risposta.azione,
    nota_operatore: risposta.nota_operatore,
    decide_domenico: risposta.decide_domenico,
    modello: completamento.modello,
    policy,
    fonti: fonti.map((f) => ({ id: f.id, titolo: f.titolo, fonte: f.fonte, url: f.url })),
  }
}
