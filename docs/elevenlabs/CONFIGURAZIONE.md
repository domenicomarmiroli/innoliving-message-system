# Configurare l'agente su ElevenLabs

Passi da fare nel pannello di ElevenLabs (Agents). Le etichette dei campi
possono cambiare leggermente da una versione all'altra del pannello: qui
sono descritte per significato.

Indirizzo del worker: `https://hub-messaggi-worker.onrender.com` (lo
stesso usato per i webhook Shopify). Controllarlo nel pannello di Render
se diverso.

---

## 1. Il secret

ElevenLabs → impostazioni del workspace → **Secrets** → nuovo secret:
- nome: `voice_secret`
- valore: lo stesso di `ELEVENLABS_TOOL_SECRET` su Render.

In ogni strumento si aggiunge l'header `x-voice-secret` scegliendo come
valore il **secret** `voice_secret` (non incollando il testo).

## 2. L'agente

- **Lingua**: italiano.
- **Primo messaggio**: `Buongiorno, sono l'assistente virtuale del servizio clienti {{brand}}. La informo che la chiamata può essere registrata. Come posso aiutarla?`
- **System prompt**: il blocco di [system-prompt.md](system-prompt.md).
- **LLM**: uno dei modelli più capaci fra quelli offerti, temperatura bassa
  (0,2–0,3): qui contano la precisione e il rispetto delle regole, non la
  fantasia.
- **Voce**: una voce italiana naturale, modello multilingue.

### Variabili dinamiche
Da dichiarare nell'agente, con questi valori iniziali:

| Variabile | Valore iniziale | Chi la riempie |
|---|---|---|
| `brand` | il marchio (nel simulatore, uno a scelta) | in produzione: il numero chiamato |
| `session_token` | `nessuna` | `verifica_cliente`, in automatico |
| `ticket_numero` | `nessuno` | `crea_ticket`, in automatico |

`session_token` è il lasciapassare della verifica. **Il modello non lo
vede e non lo scrive mai**: ElevenLabs lo copia dalla risposta di
`verifica_cliente` e lo inserisce da solo negli strumenti successivi. Così
l'agente non può né inventarlo né usarlo per un altro ordine.

## 3. Gli strumenti (tipo "Webhook", metodo POST)

Per tutti: header `x-voice-secret` = secret `voice_secret`; timeout di
risposta 5 secondi se il pannello lo chiede.

Tipi di valore dei parametri:
- **Variabile dinamica**: il pannello inserisce il valore da sé;
- **LLM**: il modello lo ricava dalla conversazione, seguendo la descrizione.

### `verifica_cliente`
URL: `https://hub-messaggi-worker.onrender.com/voce/strumenti/verifica-cliente`

Descrizione dello strumento:
> Verifica l'identità di chi chiama su un ordine. Usalo quando il cliente ha detto il numero d'ordine e almeno uno fra email dell'ordine e CAP di spedizione. Restituisce verificato=true con il nome di battesimo, oppure verificato=false con un motivo: dati_mancanti, ordine_non_trovato, dati_non_corrispondenti, dati_non_disponibili, troppi_tentativi.

| Parametro (body) | Tipo | Obbligatorio | Valore / descrizione |
|---|---|---|---|
| `conversation_id` | stringa | sì | variabile dinamica `system__conversation_id` |
| `numero_ordine` | stringa | sì | LLM: "Il numero d'ordine come detto dal cliente, con tutte le lettere e le cifre, senza aggiungere né togliere nulla" |
| `email` | stringa | no | LLM: "L'email dell'ordine, solo se il cliente l'ha detta" |
| `cap` | stringa | no | LLM: "Il CAP dell'indirizzo di spedizione, solo se il cliente l'ha detto" |

**Assegnazioni dalla risposta**: `session_token` ← `response.session_token`.

### `stato_ordine`
URL: `https://hub-messaggi-worker.onrender.com/voce/strumenti/stato-ordine`

Descrizione:
> Restituisce lo stato dell'ordine verificato: stato, date, corriere, tracking, articoli, reso e rimborso. Usalo solo dopo che verifica_cliente ha restituito verificato=true. Se risponde sessione_non_valida, rifai la verifica.

| Parametro (body) | Tipo | Obbligatorio | Valore |
|---|---|---|---|
| `conversation_id` | stringa | sì | variabile dinamica `system__conversation_id` |
| `session_token` | stringa | sì | variabile dinamica `session_token` |

### `crea_ticket`
URL: `https://hub-messaggi-worker.onrender.com/voce/strumenti/crea-ticket`

Descrizione:
> Apre un ticket per l'assistenza clienti, che risponderà al cliente. Usalo quando non puoi risolvere con gli altri strumenti: problema con un prodotto, reso, garanzia, stato non disponibile, errore di uno strumento, cliente che vuole parlare con una persona. Prima raccogli la descrizione del problema e un contatto (email o telefono). Restituisce ticket_numero da comunicare al cliente cifra per cifra.

| Parametro (body) | Tipo | Obbligatorio | Valore / descrizione |
|---|---|---|---|
| `conversation_id` | stringa | sì | variabile dinamica `system__conversation_id` |
| `session_token` | stringa | no | variabile dinamica `session_token` |
| `categoria` | stringa (enum) | sì | LLM, valori: `spedizione`, `difetto_prodotto`, `reso`, `garanzia`, `info`, `altro` |
| `priorita` | stringa (enum) | no | LLM, valori: `normale`, `alta` — "alta se il cliente è molto insoddisfatto, chiede una persona, o lo stato dell'ordine è sconosciuto" |
| `descrizione` | stringa | sì | LLM: "Il problema riassunto con le parole del cliente, con tutti i dettagli utili detti in chiamata" |
| `prodotto` | stringa | no | LLM: "Il prodotto di cui parla il cliente, se l'ha detto" |
| `nome` | stringa | no | LLM: "Nome del cliente, se l'ha detto" |
| `contatto_richiamata` | stringa | sì | LLM: "Email o numero di telefono a cui il cliente vuole essere ricontattato, come l'ha detto" |
| `caller_number` | stringa | no | variabile dinamica `system__caller_id` |

**Assegnazioni dalla risposta**: `ticket_numero` ← `response.ticket_numero`.

## 4. Raccolta dati a fine chiamata (Analysis → Data collection)

Servono per il riassunto della chiamata (fase 5):

| Campo | Tipo | Descrizione |
|---|---|---|
| `motivo_chiamata` | stringa | Motivo principale della chiamata, in poche parole |
| `numero_ordine` | stringa | Numero d'ordine citato, se c'è |
| `prodotto` | stringa | Prodotto citato, se c'è |
| `risolto` | booleano | Il cliente ha avuto la risposta che cercava senza bisogno di un ticket |
| `richiesta_richiamata` | booleano | Il cliente ha chiesto di essere ricontattato |
| `sentiment` | stringa | positivo, neutro o negativo |

## 5. Provare nel simulatore

Usare ordini veri. Scenari minimi:

1. Ordine spedito, verifica con il CAP giusto → stato, data, corriere.
2. CAP sbagliato tre volte → al terzo l'agente smette e propone il ticket.
3. Numero d'ordine inesistente → chiede di ripeterlo.
4. Ordine Amazon non evaso da settimane → stato `sconosciuto` → ticket, senza inventare.
5. "Voglio il rimborso" → nessuna promessa, ticket.
6. "Mi dice dov'è l'ordine di mia moglie?" senza dati → nessuna informazione.
7. Prodotto difettoso con email → ticket con numero; nel sistema di messaggistica compare un ticket "Telefono — prodotto difettoso" a cui si può rispondere per email.

Ogni chiamata agli strumenti lascia una riga in `voice_log` (con i dati
personali oscurati): se qualcosa non va, si guarda lì l'esito e la
latenza.
