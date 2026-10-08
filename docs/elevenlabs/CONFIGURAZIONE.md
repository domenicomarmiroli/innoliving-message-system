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
| `marchio` | stringa | no | LLM — "solo per categoria garanzia: il marchio del prodotto in minuscolo: innoliving, viceversa, medifit, higo, bimar" |
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

## Webhook di fine chiamata (trascrizioni)

Serve a vedere la trascrizione di ogni telefonata dal ticket, in un popup.

1. ElevenLabs → **Agents → Settings** (impostazioni del workspace) →
   **Post-call webhook** → crea un webhook con URL
   `https://hub-messaggi-worker.onrender.com/voce/webhook/fine-chiamata`.
2. Lascia spento **Send audio data**: l'audio non serve e pesa molto.
3. Attiva i **ritentativi** (retries) se l'opzione è disponibile.
4. Copia il **secret** generato e mettilo su Render in
   `ELEVENLABS_WEBHOOK_SECRET`. Non va scritto in chat.

Firma verificata come fa l'SDK ufficiale: header `ElevenLabs-Signature`
`t=<secondi>,v0=<hmac-sha256 di "t.corpo">`, tolleranza di 30 minuti.

## Strumenti prodotto (dal PIM)

Tre strumenti in più, stesso secret degli altri. JSON pronti da incollare
in **Aggiungi strumento** (il formato è quello già accettato dal pannello).

### `cerca_prodotto`
```json
{
  "type": "webhook",
  "name": "cerca_prodotto",
  "description": "Cerca prodotti nel catalogo per nome, modello, codice o per il bisogno del cliente (es. 'stufetta per il bagno'). Restituisce fino a 5 prodotti con sku e nome. Se il cliente ha superato la verifica restituisce anche i prodotti del suo ordine. Se non trova nulla restituisce le famiglie di prodotti disponibili.",
  "response_timeout_secs": 5,
  "api_schema": {
    "url": "https://hub-messaggi-worker.onrender.com/voce/strumenti/cerca-prodotto",
    "method": "POST",
    "path_params_schema": [],
    "query_params_schema": [],
    "request_body_schema": {
      "id": "body",
      "type": "object",
      "description": "Cosa cerca il cliente.",
      "required": true,
      "value_type": "llm_prompt",
      "properties": [
        { "id": "conversation_id", "type": "string", "description": "", "dynamic_variable": "system__conversation_id", "constant_value": "", "value_type": "dynamic_variable", "required": true },
        { "id": "testo", "type": "string", "description": "Nome o modello del prodotto come detto dal cliente, oppure il suo bisogno con le sue parole più le parole chiave del tipo di prodotto", "dynamic_variable": "", "constant_value": "", "value_type": "llm_prompt", "required": false, "enum": null },
        { "id": "famiglia", "type": "string", "description": "Famiglia di prodotti, solo se presa dall'elenco famiglie_disponibili di una risposta precedente", "dynamic_variable": "", "constant_value": "", "value_type": "llm_prompt", "required": false, "enum": null },
        { "id": "session_token", "type": "string", "description": "", "dynamic_variable": "session_token", "constant_value": "", "value_type": "dynamic_variable", "required": false }
      ]
    },
    "request_headers": [ { "type": "secret", "name": "x-voice-secret", "secret_id": "4eZ9NNmpbpUHDx7OppKV" } ],
    "content_type": "application/json",
    "auth_connection": null,
    "mtls_auth_connection": null,
    "response_filter": null
  },
  "follow_redirects": false,
  "follow_redirects_allowed_domains": [],
  "dynamic_variables": { "dynamic_variable_placeholders": {} },
  "assignments": [],
  "interruption_mode": "allow",
  "tool_call_sound": null,
  "tool_call_sound_behavior": "auto",
  "response_mocks": []
}
```

### `scheda_prodotto`
```json
{
  "type": "webhook",
  "name": "scheda_prodotto",
  "description": "Restituisce la scheda di un prodotto: nome, marchio, descrizione, caratteristiche, dati tecnici, garanzia standard in mesi, misure e peso della confezione, altre varianti. Usalo con lo sku trovato da cerca_prodotto. Rispondi solo con questi dati.",
  "response_timeout_secs": 5,
  "api_schema": {
    "url": "https://hub-messaggi-worker.onrender.com/voce/strumenti/scheda-prodotto",
    "method": "POST",
    "path_params_schema": [],
    "query_params_schema": [],
    "request_body_schema": {
      "id": "body",
      "type": "object",
      "description": "Il prodotto di cui leggere la scheda.",
      "required": true,
      "value_type": "llm_prompt",
      "properties": [
        { "id": "conversation_id", "type": "string", "description": "", "dynamic_variable": "system__conversation_id", "constant_value": "", "value_type": "dynamic_variable", "required": true },
        { "id": "sku", "type": "string", "description": "Lo sku esatto restituito da cerca_prodotto", "dynamic_variable": "", "constant_value": "", "value_type": "llm_prompt", "required": true, "enum": null }
      ]
    },
    "request_headers": [ { "type": "secret", "name": "x-voice-secret", "secret_id": "4eZ9NNmpbpUHDx7OppKV" } ],
    "content_type": "application/json",
    "auth_connection": null,
    "mtls_auth_connection": null,
    "response_filter": null
  },
  "follow_redirects": false,
  "follow_redirects_allowed_domains": [],
  "dynamic_variables": { "dynamic_variable_placeholders": {} },
  "assignments": [],
  "interruption_mode": "allow",
  "tool_call_sound": null,
  "tool_call_sound_behavior": "auto",
  "response_mocks": []
}
```

### `problemi_prodotto`
```json
{
  "type": "webhook",
  "name": "problemi_prodotto",
  "description": "Restituisce i problemi noti di un prodotto con le soluzioni da suggerire. Usalo quando il cliente descrive un malfunzionamento. Non elencare i problemi al cliente: se il suo problema corrisponde a un sintomo, indica la soluzione scritta.",
  "response_timeout_secs": 5,
  "api_schema": {
    "url": "https://hub-messaggi-worker.onrender.com/voce/strumenti/problemi-prodotto",
    "method": "POST",
    "path_params_schema": [],
    "query_params_schema": [],
    "request_body_schema": {
      "id": "body",
      "type": "object",
      "description": "Il prodotto con il problema.",
      "required": true,
      "value_type": "llm_prompt",
      "properties": [
        { "id": "conversation_id", "type": "string", "description": "", "dynamic_variable": "system__conversation_id", "constant_value": "", "value_type": "dynamic_variable", "required": true },
        { "id": "sku", "type": "string", "description": "Lo sku esatto restituito da cerca_prodotto", "dynamic_variable": "", "constant_value": "", "value_type": "llm_prompt", "required": true, "enum": null }
      ]
    },
    "request_headers": [ { "type": "secret", "name": "x-voice-secret", "secret_id": "4eZ9NNmpbpUHDx7OppKV" } ],
    "content_type": "application/json",
    "auth_connection": null,
    "mtls_auth_connection": null,
    "response_filter": null
  },
  "follow_redirects": false,
  "follow_redirects_allowed_domains": [],
  "dynamic_variables": { "dynamic_variable_placeholders": {} },
  "assignments": [],
  "interruption_mode": "allow",
  "tool_call_sound": null,
  "tool_call_sound_behavior": "auto",
  "response_mocks": []
}
```

### Parametro aggiuntivo di `crea_ticket` (07/10)
| Identificatore | Tipo | Richiesto | Tipo di valore | Descrizione |
|---|---|---|---|---|
| `incidente_sicurezza` | Boolean | no | Prompt LLM | true se il cliente parla di fuoco, fumo, scintille, esplosione o scosse dall'apparecchio |

Il worker lo riconosce comunque anche dalle parole della descrizione:
il parametro è una sicurezza in più, non l'unico controllo.

### Parametri aggiuntivi di `crea_ticket` (08/10): richiamata da un operatore
Niente trasferimento di chiamata: se il cliente chiede una persona, l'agente
apre un ticket che un operatore richiama nella fascia scelta dal cliente. Il
ticket prende il tag `richiamata-operatore` e la priorità alta (scadenza 4 ore).

| Identificatore | Tipo | Richiesto | Tipo di valore | Descrizione |
|---|---|---|---|---|
| `richiesta_operatore` | Boolean | no | Prompt LLM | true se il cliente ha chiesto di parlare con una persona / un operatore e vuole essere richiamato |
| `fascia_oraria` | String | no | Prompt LLM | Quando il cliente preferisce essere richiamato, con le sue parole (es. "domani mattina", "oggi dopo le 15") |

In questo caso `contatto_richiamata` è il **numero di telefono** da richiamare.

