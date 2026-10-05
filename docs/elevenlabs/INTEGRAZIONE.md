# Agente vocale ElevenLabs — piano e stato

Versione adattata al codice reale del documento operativo originale
(`ELEVENLABS_INTEGRATION.md`, ricevuto il 05/10). Le fasi restano quelle;
cambiano dove vive il middleware e alcune scelte, spiegate sotto.
**Questa tabella "Stato avanzamento" è quella da aggiornare**, non la copia
originale.

## Obiettivo

Un agente vocale che risponde ai clienti al telefono con **dati certi**,
presi solo dalle nostre API: se un dato non arriva da uno strumento, non
lo dice. Quando non sa rispondere apre un ticket nel sistema di
messaggistica; l'operatore risponde dal ticket, anche **richiamando il
cliente con l'agente vocale**, che gli riferisce quello che l'operatore ha
scritto (richiesta del 05/10).

## Decisioni prese (05/10)

| Tema | Decisione | Perché |
|---|---|---|
| Dove sta il middleware | Nel worker su Render (rotte `/voce/*`), non in Supabase Edge Functions | Ordini di tutti i canali già nel database, apertura ticket già esistente (siamo noi il "Message System"), oscuramento PII, test e deploy già presenti. Render è sempre acceso. |
| Negozi Shopify | Uno solo, quattro frontend (Innoliving, Bimar, Viceversa, Inshopping) | Nessuna sincronizzazione multi-negozio: `SHOPIFY_STORES` del documento originale non serve. Il marchio si ricava dal frontend/canale dell'ordine, non dal negozio. |
| Gestionale | Odoo, unico per tutte le vendite, da integrare più avanti | Per ora gli ordini si leggono dalla tabella `order` (Shopify + Amazon + Mirakl). |
| Corrieri | Ordini: sempre BRT. Assistenza: anche GLS | Il tracking a eventi (fase 3) parte da BRT. |
| Telefonia | Prima solo test nel simulatore di ElevenLabs; il numero attuale si collega solo se il risultato è ottimo | La fase 7 resta ferma fino a quel giudizio. |
| Numero del ticket | Numero progressivo breve per tutti i ticket (fase 4) | Un UUID non si può dettare al telefono; utile anche in interfaccia. |
| Verifica cliente | Numero d'ordine + email **o** CAP | Su Amazon e Mirakl l'email è un alias o manca: lì il controllo realistico è il CAP. |

## Fasi

| Fase | Contenuto | Note di adattamento |
|---|---|---|
| 1 – Fondamenta | Tabelle `voice_session`/`voice_log`/`voice_call` (migrazione 0030), secret obbligatorio, registro con PII oscurate, `GET /voce/health` | Fatto, vedi sotto. |
| 2 – Verifica cliente | `POST /voce/strumenti/verifica-cliente` | Ricerca sulla tabella `order` locale, non su Shopify in diretta: millisecondi invece di secondi. Tentativi contati da `voice_log.esito`. Token di sessione salvato solo come impronta. |
| 3 – Stato ordine e tracking | `stato-ordine`, `tracking` | Stato e corriere/tracking già in `order`. Gli **eventi** di spedizione (giacenza, in consegna) non li abbiamo: serve l'API di tracciamento BRT o un aggregatore. Da decidere. |
| 4 – Ticket | `crea-ticket` | Nuovo genere di canale `telefono` (come `contatto`), numero progressivo breve. Il contatto per la risposta (email o telefono) si raccoglie durante la chiamata. |
| 5 – Fine chiamata | Webhook firmato HMAC → `voice_call`, trascrizione come nota interna sul ticket | Ticket di ripiego se la chiamata finisce senza soluzione né ticket. |
| 5b – Richiamata vocale | Dal ticket, l'operatore scrive la risposta e avvia una chiamata in uscita: l'agente la riferisce al cliente | Richiesta del 05/10. Richiede un numero collegato (fase 7): si prepara prima, si collauda dopo. API di chiamata in uscita ElevenLabs da verificare sulla documentazione al momento di implementarla. |
| 6 – Configurazione agente | `tools-config.json`, system prompt, data collection | In questa cartella. Nessuna modifica su ElevenLabs senza conferma. |
| 7 – Telefonia | Numero attuale via SIP trunk | Solo dopo i test nel simulatore. |
| 8 – Test e pilota | Scenari nel simulatore | Pilota: "dov'è il mio ordine". |
| 9 – Estensioni | Info prodotto dal PIM, garanzie, WhatsApp | WhatsApp: l'agente ElevenLabs può rispondere su WhatsApp con gli stessi strumenti, ma il passaggio a un operatore è ancora "coming soon" nella loro documentazione. Un canale WhatsApp gestito dagli operatori nel nostro sistema si fa invece con le API Meta. Da decidere dopo il pilota. |

## Fase 1 — cosa c'è

- `db/migrations/0030_voce.sql`: le tre tabelle, RLS attiva senza policy
  (solo il worker le legge).
- `src/routes/voce.ts`: plugin incapsulato. Un hook `onRequest` rifiuta con
  401 ogni richiesta senza `x-voice-secret` corretto (confronto a tempo
  costante); un hook `onResponse` scrive una riga in `voice_log` per ogni
  richiesta, rifiutate comprese, **dopo** aver risposto (nessuna latenza in
  più al telefono). Senza `ELEVENLABS_TOOL_SECRET` (minimo 32 caratteri) le
  rotte non esistono.
- `src/core/voce/oscura.ts`: oscuramento della richiesta prima del
  registro. Campi riconosciuti dal nome con una traccia utile (`m***@gmail.com`,
  `***567`, `20***`, iniziale del nome); testo libero ripulito da email,
  telefoni, IBAN, carte e codici fiscali. I numeri d'ordine Amazon non
  vengono scambiati per telefoni (test dedicato).
- `test/voce.test.ts`: 401 senza secret o con secret sbagliato, 200 con
  quello giusto, riga di registro in entrambi i casi, 503 leggibile se il
  database non risponde, nessuna PII in chiaro.

### Per attivarla
1. Eseguire `0030_voce.sql` nell'editor SQL di Supabase.
2. Generare un secret di almeno 32 caratteri e metterlo in Render come
   `ELEVENLABS_TOOL_SECRET`.
3. Verifica: `GET /voce/health` senza header → 401; con
   `x-voice-secret` → `{"ok":true}`; in `voice_log` una riga per ciascuna.

## Stato avanzamento

| Fase | Stato | Note |
|---|---|---|
| 1 – Fondamenta | ✅ codice e test (05/10) | Da applicare 0030 e impostare il secret su Render |
| 2 – Verifica cliente | ⬜ | |
| 3 – Stato ordine e tracking | ⬜ | API eventi BRT da chiarire |
| 4 – Ticket | ⬜ | |
| 5 – Post-call | ⬜ | |
| 5b – Richiamata vocale | ⬜ | Dopo la fase 7 per il collaudo |
| 6 – Config agente | ⬜ | |
| 7 – Telefonia | ⏸ | Dopo i test nel simulatore |
| 8 – Test e pilota | ⬜ | |
| 9 – Estensioni | ⬜ | |
