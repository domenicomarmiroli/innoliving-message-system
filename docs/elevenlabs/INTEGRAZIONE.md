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

### Per attivarla (fatto il 05/10, verificato in `voice_log`)
1. Eseguire `0030_voce.sql` nell'editor SQL di Supabase.
2. Generare un secret di almeno 32 caratteri e metterlo in Render come
   `ELEVENLABS_TOOL_SECRET`.
3. Verifica: `GET /voce/health` senza header → 401; con
   `x-voice-secret` → `{"ok":true}`; in `voice_log` una riga per ciascuna.

## Fase 2 — verifica del cliente

`POST /voce/strumenti/verifica-cliente`

```json
{ "conversation_id": "…", "numero_ordine": "407 6086160 1682752", "email": null, "cap": "20121" }
```

Risposte (sempre 200, tranne input malformato 400 e guasto 503):

| Caso | Risposta |
|---|---|
| Verificato | `{ "verificato": true, "session_token": "…", "nome": "Mario", "brand": "…", "canale": "Amazon" }` |
| Manca sia email sia CAP | `{ "verificato": false, "motivo": "dati_mancanti" }` — non conta come tentativo |
| Numero inesistente | `motivo: "ordine_non_trovato"` |
| Dati sbagliati | `motivo: "dati_non_corrispondenti"` |
| Ordine senza email né CAP in archivio | `motivo: "dati_non_disponibili"` — l'agente apre un ticket |
| Terzo fallimento nella stessa telefonata | `motivo: "troppi_tentativi"` |

- **Il numero si confronta ridotto a lettere e cifre**, sia quello dettato
  sia quelli in archivio (numero del canale e numero del negozio). Provato
  sul database vero con i cinque formati in uso: Amazon dettato con spazi,
  numero del sito con e senza prefisso, solo cifre, Mirakl dei due
  operatori — un ordine trovato per ciascuno.
- **Basta un dato**: email oppure CAP di spedizione. Su un rifiuto non
  esce nessun dato dell'ordine, nemmeno il nome.
- Dopo la verifica: solo il **nome di battesimo**, il marchio (attributo
  `_brand` dell'ordine, quando il frontend lo scrive) e il canale.
- Il token vale 30 minuti ed è legato a quell'ordine; in `voice_session`
  c'è solo la sua impronta SHA-256.
- I tentativi si contano da `voice_log.esito` della stessa conversazione.

### Dati mancanti trovati preparando la fase 2
- **L'email non veniva mai chiesta a Shopify.** Aggiunta alla query
  (`connectors/shopify/campi.ts`, ora unica per backfill e giro periodico)
  e salvata in `order.email` (migrazione 0031). È un dato cliente protetto:
  se l'app Shopify non ha il permesso, la sincronizzazione prosegue senza
  email (un avviso nel log) invece di fermarsi.
- **Il CAP c'era solo sugli ordini sincronizzati dopo la 0013**: degli
  ordini Amazon degli ultimi 90 giorni, 802 su 2.484. Dopo il deploy si
  completano con `npm run shopify:sync -- --creati-dal AAAA-MM-GG`, che
  ripassa gli ordini creati da quella data senza toccare il segnalibro
  del giro periodico.
- Sugli ordini dei marketplace l'email di Shopify è un alias del relay:
  per quei clienti la verifica passa di fatto dal CAP.
- Gli ordini eBay arrivano come canale `shopify` (fonte dell'app eBay) e
  l'agente li chiamerebbe "sito": da sistemare nel riconoscimento del
  canale, non qui.

## Fase 3 — stato dell'ordine

`POST /voce/strumenti/stato-ordine` con `{ conversation_id, session_token }`.
**Non accetta un numero d'ordine**: l'ordine viene solo dalla sessione
della verifica.

```json
{
  "stato": "spedito", "spedizione_parziale": false, "canale": "sito",
  "data_ordine": "28 settembre", "data_spedizione": "30 settembre",
  "corriere": "BRT", "tracking_disponibile": true, "numero_tracking": "…",
  "gestito_da_amazon": false,
  "articoli": ["Stufa X (1 pezzo)"],
  "reso_richiesto_il": null, "rimborso": null
}
```

Sessione scaduta o inventata → `{ "errore": "sessione_non_valida" }`:
l'agente rifà la verifica. Ogni strumento ha un limite di 3,5 secondi,
oltre il quale risponde `servizio_non_disponibile` (503).

**Cosa dicono i dati veri (05/10, ultimi 60 giorni)**

| Canale | Ordini | Con tracking |
|---|---|---|
| Amazon | 2.483 | 0 |
| Sito | 93 | 72 (BRT, GLS) |
| MediaWorld | 82 | 75 (BRT) |
| TikTok | 47 | 45 (BRT) |
| eBay | 28 | 23 (BRT) |

- **Aggiornato il 06/10 — stato dal gestionale.** Gli ordini Amazon
  spediti da noi (tag Shopify `FBM`) prendono tracking e stato del pacco
  dai pacchetti Zoho (`order.spedizione_stato`, migrazione 0033):
  `statoOrdine()` li fa prevalere su Shopify, quindi ora esce anche
  `consegnato`. Al primo giro: 427 ordini FBM su 470 coperti.
- **Ordini FBA** (tag `FBA`, spediti da Amazon): nessun pacchetto Zoho,
  e il customer care della consegna lo fa Amazon. La risposta porta
  `gestito_da_amazon: true` e il prompt indirizza il cliente ad Amazon.
- Per gli ordini del sito e degli altri marketplace `consegnato` resta
  non disponibile: Shopify non riceve l'evento di consegna. Gli eventi
  intermedi (giacenza, in consegna) richiederebbero un servizio di
  tracking: l'API BRT vuole il segnacollo, che non abbiamo.
- Resta valida la regola dei 7 giorni (`GIORNI_PREPARAZIONE_CREDIBILI`)
  per gli ordini senza dato del gestionale.
- Ordini Leroy Merlin con corriere "Amazon Logistics US": quasi certamente
  un valore sbagliato nell'integrazione, non il corriere vero.
- La data di spedizione e l'annullamento vengono dai campi
  `fulfillments.createdAt` e `cancelledAt`, aggiunti alla query il 05/10:
  sugli ordini già in archivio compaiono dopo un nuovo
  `npm run shopify:sync -- --creati-dal …`.

## Fase 4 — apertura ticket

`POST /voce/strumenti/crea-ticket` → `{ "ticket_numero": "10234", "messaggio": "Ticket 10234 aperto" }`.

- Nuovo canale `telefono` (account `telefono-ai`, SLA 8 ore; 4 ore se
  priorità alta) e **numero breve per tutti i ticket** (`thread.numero`,
  da 10001, assegnato dal database): migrazione 0032.
- Un ticket per telefonata (`external_thread_id` = `conversation_id`): una
  seconda chiamata allo strumento aggiunge un messaggio, non un ticket.
- Funziona anche senza verifica; con la verifica il ticket è legato
  all'ordine e l'oggetto lo cita.
- Tag: `telefono`, la categoria tradotta nella tassonomia esistente
  (`prodotto-difettoso`, `reso`…) e `priorita-alta` se serve.
- Se il contatto è un'email va in `raw.from`: l'operatore risponde dal
  ticket per email (dalla casella Microsoft se configurata). Con il solo
  telefono, la risposta è una richiamata (fase 5b).

Configurazione su ElevenLabs: [CONFIGURAZIONE.md](CONFIGURAZIONE.md), prompt
in [system-prompt.md](system-prompt.md). Il `session_token` passa da uno
strumento all'altro come variabile dinamica assegnata dalla risposta: il
modello non lo vede mai.

## Stato avanzamento

| Fase | Stato | Note |
|---|---|---|
| 1 – Fondamenta | ✅ codice e test (05/10) | Da applicare 0030 e impostare il secret su Render |
| 2 – Verifica cliente | ✅ in produzione (05/10) | Ordini da ottobre 2025 riallineati: 3.919 con email |
| 3 – Stato ordine e tracking | 🟡 stato ordine fatto (05/10) | Eventi di consegna: BRT o un servizio tipo Qapla', più avanti. Tracking Amazon: arriverà col nuovo gestionale |
| 4 – Ticket | ✅ codice e test (05/10) | Migrazione 0032 da applicare prima del deploy |
| 5 – Post-call | ⬜ | |
| 5b – Richiamata vocale | ⬜ | Dopo la fase 7 per il collaudo |
| 6 – Config agente | 🟡 guida e prompt pronti (05/10) | Da configurare nel pannello ElevenLabs e provare nel simulatore |
| 7 – Telefonia | ⏸ | Dopo i test nel simulatore |
| 8 – Test e pilota | ⬜ | |
| 9 – Estensioni | ⬜ | |
