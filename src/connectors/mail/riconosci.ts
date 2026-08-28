import type { EmailGrezza, RegolaCanale, Riconoscimento } from './tipi.js'

/**
 * Da quale canale arriva questa email, e per quale ordine.
 *
 * Funzione pura: le regole arrivano dal database (channel_account.config),
 * non dal codice. Aggiungere un marketplace è una riga di SQL.
 *
 * Il riconoscimento guarda il DOMINIO del mittente, non l'indirizzo:
 * gli alias dei relay sono generati per ogni acquirente e non si possono
 * elencare. Il dominio invece è stabile.
 */

/** Estrae la parte dopo la @, in minuscolo. Null se non è un indirizzo. */
export function dominioDi(indirizzo: string | null | undefined): string | null {
  if (!indirizzo) return null
  // Tollera la forma "Nome Cognome <tizio@esempio.it>".
  const dentroParentesi = indirizzo.match(/<([^>]+)>/)
  const pulito = (dentroParentesi?.[1] ?? indirizzo).trim().toLowerCase()
  const chiocciola = pulito.lastIndexOf('@')
  if (chiocciola < 1 || chiocciola === pulito.length - 1) return null
  return pulito.slice(chiocciola + 1)
}

/** Normalizza un indirizzo alla sola parte "tizio@esempio.it", in minuscolo. */
export function indirizzoDi(indirizzo: string | null | undefined): string | null {
  if (!indirizzo) return null
  const dentroParentesi = indirizzo.match(/<([^>]+)>/)
  const pulito = (dentroParentesi?.[1] ?? indirizzo).trim().toLowerCase()
  return pulito.includes('@') ? pulito : null
}

/**
 * Il dominio combacia con la regola?
 *
 * Confronto per suffisso di etichetta, non `includes`. Data la regola
 * "relay.esempio.it": accetta "a.relay.esempio.it" (sottodominio vero) e
 * rifiuta "relay.esempio.it.truffa.com", che con `includes` passerebbe.
 * È esattamente così che si fa accettare posta falsa a un sistema che
 * decide in base al mittente.
 */
export function dominioCombacia(dominio: string, regola: string): boolean {
  const d = dominio.toLowerCase()
  const r = regola.toLowerCase()
  return d === r || d.endsWith('.' + r)
}

/**
 * Questa email va scartata prima ancora di guardarla?
 *
 * Lista di ESCLUSI, non di ammessi. La differenza non è di stile: con
 * una lista di ammessi, il messaggio di un cliente che scrive da un
 * indirizzo nuovo sparisce senza che nessuno se ne accorga. Con una
 * lista di esclusi il caso peggiore è un po' di rumore in coda, che si
 * vede e si corregge.
 *
 * Si guardano sia il From sia il Reply-To: basta che uno dei due sia in
 * lista perché il messaggio non entri.
 */
export function daEscludere(
  email: Pick<EmailGrezza, 'from' | 'reply_to'>,
  dominiEsclusi: string[],
): boolean {
  if (dominiEsclusi.length === 0) return false
  for (const indirizzo of [email.from, email.reply_to]) {
    const dominio = dominioDi(indirizzo)
    if (!dominio) continue
    if (dominiEsclusi.some((d) => dominioCombacia(dominio, d))) return true
  }
  return false
}

/** Che genere di posta è, prima ancora di chiedersi da quale canale viene. */
export type GenereMittente = 'escluso' | 'reso' | 'notifica' | 'avviso' | 'messaggio'

/**
 * Valori noti di `X-Space-Notification-Type` che sono richieste di reso.
 * Non è un dato specifico di questa azienda: è la tassonomia di Amazon,
 * uguale per chiunque venda su Amazon con questo sistema.
 */
const TIPI_RESO = ['RETURN_REQUEST']

export function classificaMittente(
  email: Pick<EmailGrezza, 'from' | 'reply_to' | 'notifica_tipo'>,
  opzioni: {
    domini_esclusi: string[]
    domini_notifica: string[]
    domini_avviso: string[]
  },
  regole: RegolaCanale[] = [],
): GenereMittente {
  // L'ordine di queste righe è la parte delicata di tutto il modulo.
  //
  // 1. L'esclusione esplicita vince su tutto: `sell.amazon.com` resta
  //    fuori senza essere scambiato per altro solo per via del suffisso.
  if (daEscludere(email, opzioni.domini_esclusi)) return 'escluso'

  // 2. Un canale di vendita riconosciuto è SEMPRE un messaggio, e viene
  //    prima delle altre liste. Il dominio del relay dei clienti è un
  //    SOTTODOMINIO di quello da cui arrivano gli avvisi della
  //    piattaforma: senza questa riga i messaggi dei clienti verrebbero
  //    inghiottiti dalla lista degli avvisi e il canale principale si
  //    spegnerebbe in silenzio. È il motivo per cui esiste un test che
  //    tiene separati i due casi.
  const domini = regole.flatMap((r) => r.sender_domains)
  if (daEscludere(email, domini)) return 'messaggio'

  // 3. Le richieste di reso PRIMA delle liste per dominio: condividono
  //    `amazon.com` con le notifiche di mancata consegna (domini_notifica),
  //    ma l'header dice esattamente di cosa si tratta — senza questo
  //    controllo qui, una richiesta di reso verrebbe scambiata per una
  //    notifica di mancata consegna e riaprirebbe il thread sbagliato,
  //    con il messaggio sbagliato.
  if (email.notifica_tipo && TIPI_RESO.includes(email.notifica_tipo)) return 'reso'

  // 4. Solo ora le liste per genere.
  if (daEscludere(email, opzioni.domini_avviso)) return 'avviso'
  if (daEscludere(email, opzioni.domini_notifica)) return 'notifica'
  return 'messaggio'
}

export function riconosci(
  email: EmailGrezza,
  regole: RegolaCanale[],
  casella: RegolaCanale,
): Riconoscimento {
  // Il mittente vero di un relay a volte sta nel Reply-To e non nel From:
  // guardiamo entrambi, nell'ordine in cui è più probabile trovarlo.
  const candidati = [email.reply_to, email.from]
    .map(indirizzoDi)
    .filter((x): x is string => x !== null)

  for (const indirizzo of candidati) {
    const dominio = dominioDi(indirizzo)
    if (!dominio) continue

    const regola = regole.find((r) =>
      r.sender_domains.some((dom) => dominioCombacia(dominio, dom)),
    )
    if (!regola) continue

    return {
      account_id: regola.account_id,
      account_code: regola.code,
      kind: regola.kind,
      alias: indirizzo,
      numero_ordine: estraiNumeroOrdine(email, regola.order_id_pattern),
      // L'alias c'è, ma se corrisponda davvero a un ordine lo dirà
      // l'aggancio: qui registriamo solo che l'abbiamo trovato.
      strategia: 'alias',
      testo: regola.testo,
    }
  }

  // Nessun relay riconosciuto: è posta diretta di un cliente, oppure un
  // mittente nuovo. Va sulla casella, non si inventa un canale.
  return {
    account_id: casella.account_id,
    account_code: casella.code,
    kind: casella.kind,
    alias: candidati[0] ?? null,
    numero_ordine: estraiNumeroOrdine(email, null),
    strategia: 'nessuna',
    testo: casella.testo,
  }
}

/**
 * Numero d'ordine nel testo.
 *
 * Solo formati con una forma fissa e inequivocabile. Non tentiamo di
 * interpretare il layout delle email: quello cambia senza preavviso e
 * senza esemplari reali sarebbe indovinare. Il pattern arriva dalla
 * configurazione; senza pattern proviamo comunque quello Amazon, che è
 * abbastanza caratteristico da non produrre falsi positivi.
 */
export function estraiNumeroOrdine(
  email: EmailGrezza,
  pattern: string | null,
): string | null {
  const AMAZON = /\d{3}-\d{7}-\d{7}/
  let regex: RegExp
  try {
    regex = pattern ? new RegExp(pattern) : AMAZON
  } catch {
    // Un pattern scritto male in configurazione non deve fermare
    // l'ingestione: si ripiega su quello noto.
    regex = AMAZON
  }

  // L'oggetto prima del corpo: se il numero c'è nell'oggetto è quello
  // dell'ordine di cui si parla, mentre il corpo può citarne altri
  // (firme, storici, messaggi inoltrati).
  for (const testo of [email.subject, email.body_text]) {
    if (!testo) continue
    const trovato = testo.match(regex)
    if (trovato) return trovato[0]
  }
  return null
}
