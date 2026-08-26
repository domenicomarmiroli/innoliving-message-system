# Worker — Hub Messaggi Marketplace

## Cosa è questo servizio
Un singolo web service Node che fa tre cose: riceve i webhook Shopify, riceve
le notifiche Microsoft Graph della casella assistenza, e fa polling sulle API
messaggi Mirakl. Normalizza tutto e scrive su Supabase. Espone anche gli
endpoint di invio risposta e di generazione bozza.

L'interfaccia è un progetto Lovable separato che legge dallo stesso database.
Questo repo non contiene interfaccia.

## Stack
Node 22, TypeScript strict, Fastify 5, postgres.js (NON un ORM), zod per la
validazione, pino per il logging, vitest per i test.

## Regole assolute

1. **Lo schema del database appartiene a QUESTO repo.**
   Il database è un progetto Supabase esterno, non Lovable Cloud: Lovable ci
   si collega come client e non gestisce le migrazioni. Quindi la verità sta
   in `db/migrations/`, numerate progressivamente, e si applicano a mano
   nell'editor SQL di Supabase. `db/schema.sql` è lo snapshot corrente,
   rigenerato dopo ogni migrazione.
   Le modifiche allo schema si concordano prima: l'interfaccia Lovable legge
   le stesse tabelle, e cambiarle senza avvisarla la rompe.

2. **Ogni scrittura verso il database deve essere idempotente.** Il worker può
   riprocessare lo stesso batch dieci volte senza duplicare nulla: usa sempre
   `ON CONFLICT` sui vincoli unique già presenti nello schema.

3. **Nessun segreto nel repo.** Solo `.env.example` con i nomi. La
   configurazione si valida con zod all'avvio: se manca una variabile il
   processo esce subito dicendo quale.

4. **Il payload originale di ogni messaggio e di ogni ordine va salvato
   integralmente nella colonna `raw`.** Non scartare mai il grezzo: quando
   scopriremo che un parser sbagliava, riprocesseremo da lì.

5. **Un errore non si perde mai.** Ciò che fallisce dopo i retry finisce in
   `ingest_anomaly` con il payload, non in un log e basta.

6. **Nessun parser senza fixture.** Ogni formato di email che sappiamo
   riconoscere ha almeno un file reale in `test/fixtures/` e un test.

7. **Niente valori specifici di questa azienda nel codice**: né domini, né nomi
   di store, né operatori Mirakl, né indirizzi. Vengono da `channel_account`,
   da `app_config` o dalle variabili d'ambiente. Il test
   `test/no-hardcoded.test.ts` lo verifica: se lo fai fallire, la soluzione è
   spostare il valore in configurazione, non allungare la lista delle
   eccezioni.

8. **Dati personali fuori dai log e fuori dai prompt.** IBAN, numeri di carta e
   codici fiscali vanno oscurati prima di finire in un log, in un prompt al
   modello o negli esempi di risposta.

## Connessione al database
Via `SUPABASE_DB_URL`, che punta al **Supavisor shared pooler in session
mode** (`aws-<region>.pooler.supabase.com`, porta 5432).
NON usare la connessione diretta `db.<ref>.supabase.co`: è IPv6-only e Render
non la raggiunge.

## Attenzione: tabella "case"
La tabella delle pratiche si chiama `case`, che è parola riservata in SQL.
Va **sempre virgolettata** nelle query scritte a mano: `from "case"`.

## Struttura
```
src/config.ts       validazione della configurazione, unica fonte
src/logger.ts       logging strutturato con oscuramento
src/db/             connessione e query, nient'altro
src/routes/         endpoint HTTP e webhook
src/connectors/     un modulo per canale: graph, shopify, mirakl
src/core/           matching, threading, policy, drafting
test/fixtures/      email e payload reali, anonimizzati
db/schema.sql       copia in sola lettura dello schema
```

## Comandi
```
npm run dev         avvio in sviluppo con ricarica
npm test            test
npm run typecheck   controllo dei tipi
npm run build       compilazione
```
Comandi previsti dai passi successivi del runbook, non ancora implementati:
`backfill:shopify`, `graph:subscribe`, `graph:delta`, `ricambi:deriva`,
`instance:init`, `instance:export`, `eval:classify`.

## Stile
Niente `any`. Funzioni pure dove possibile, effetti collaterali confinati in
`src/db` e `src/connectors`. Commenti solo dove il perché non è ovvio dal
codice.

## Chiavi Supabase: chi tiene cosa
- **Worker (questo repo)**: `SUPABASE_DB_URL`, la connection string del
  *session pooler*. Bypassa RLS. Vive solo nelle variabili d'ambiente di
  Render.
- **Interfaccia Lovable**: solo `SUPABASE_URL` e la chiave *publishable*
  (anon). Passa da RLS, come deve.
- La **service_role key non va mai data a Lovable** né a qualunque cosa che
  finisca in un bundle servito al browser: bypassa RLS e aprirebbe in lettura
  e scrittura tutti i messaggi dei clienti.

## Cosa resta da fare
Vedi **`STATO.md`** nella radice del repository: elenca i passi aperti, i
debiti dichiarati (parti scritte sulla documentazione e non su dati reali) e
il problema strutturale degli ordini Amazon che non passano da Shopify.
Va letto prima di riprendere il lavoro, e aggiornato man mano che i punti si
chiudono.

## Stato attuale
Fatto: scheletro, configurazione validata, connessione al database, `/health`,
migrazione iniziale con schema/RLS/seed, e il **connettore Shopify completo**
(passo 04 del runbook):
- `src/connectors/shopify/normalize.ts` — due adattatori (webhook REST e
  GraphQL) verso un solo normalizzatore. Il riconoscimento del canale è
  scritto una volta sola ed è testato su payload reali dello store.
- `src/connectors/shopify/hmac.ts` — verifica della firma sul corpo grezzo,
  confronto a tempo costante.
- `src/connectors/shopify/upsert.ts` — scrittura idempotente con gestione del
  duplicato Amazon noto: non sovrascrive in silenzio, tiene il più recente e
  registra lo scarto in `ingest_anomaly`.
- `src/connectors/shopify/backfill.ts` — paginazione con cursore salvato in
  `sync_state`, gestione del 429.
- `src/routes/webhooks-shopify.ts` — risposta 200 immediata, elaborazione
  dopo: Shopify ritenta i webhook che tardano più di 5 secondi.
22 test verdi, di cui 13 sul riconoscimento del canale.

### Autenticazione Shopify
Le app create dall'admin del negozio (token statico `shpat_`) non sono più
creabili. Le app del Dev Dashboard non espongono nessun token da copiare: si
usa il **client credentials grant**, cioè il worker scambia client id e secret
per un token valido 24 ore, in `src/connectors/shopify/token.ts`.
Il token statico resta supportato e ha la precedenza, per le installazioni che
ce l'hanno già.

### Allineamento degli ordini
Due vie, e servono entrambe.

**I webhook** sono la via principale: `orders/create`, `orders/updated`,
`fulfillments/create` verso `/webhooks/shopify`. Si registrano con
`npm run shopify:webhooks -- https://<host>` — idempotente, crea solo il
mancante. L'indirizzo si passa come argomento perché cambia da
installazione a installazione e non deve stare nel codice.

**Il giro periodico** (`SHOPIFY_SYNC_MINUTES`, default 60) è la rete sotto.
Un sistema che si fida solo dei webhook prima o poi perde qualcosa: un
riavvio durante il deploy, un 500 momentaneo, una notifica ritentata e poi
abbandonata. Un ordine mancante significa un cliente che scrive di un ordine
che per noi non esiste.

Differenza col backfill: quello guarda `created_at` e serve una volta sola,
questo guarda **`updated_at`** — un ordine spedito ieri e tracciato oggi non è
nuovo ma è cambiato, e il tracking è la risposta a "dov'è il mio pacco".
Il segnalibro sta in `app_config.shopify_sync`, **non** in
`sync_state.api_cursor`: quel campo per l'account Shopify contiene il cursore
di paginazione del backfill, e sovrascriverlo romperebbe la ripresa di un
backfill interrotto.

### Connettore casella (passo 05)
La casella è su Gmail, letta via **IMAP** e scritta via **SMTP** con una
*password per app*. Microsoft Graph resta la destinazione finale — le variabili
`MS_*` sono già previste — ma richiede permessi che oggi non abbiamo: quando
arriveranno si sostituisce `src/connectors/mail/imap.ts` e `invia.ts`, il resto
non se ne accorge.

Perché non le API Gmail: con la schermata di consenso in stato *Testing* il
refresh token scade ogni 7 giorni e l'integrazione si spegne da sola. La
password per app non ha scadenza.

- `riconosci.ts` — canale dal **dominio** del mittente (Reply-To prima del From).
  I domini stanno in `channel_account.config.sender_domains`, non nel codice.
  Il confronto è per suffisso di etichetta: `includes` accetterebbe
  `relay.esempio.it.truffa.com`.
- `aggancia.ts` — tre strade in ordine di affidabilità: catena
  In-Reply-To/References → `order.buyer_alias` → numero d'ordine nel testo.
  Nessun aggancio ⇒ thread `unmatched`, che non è un errore.
- `upsert.ts` — idempotente sul vincolo `message_rfc822_key`. Rileggere tutta
  la casella non duplica niente.
- `imap.ts` — riprende dall'UID in `sync_state`; se cambia UIDVALIDITY riparte
  da capo e lascia decidere al vincolo sul Message-ID.
- `poll.ts` — un giro ogni `MAIL_POLL_SECONDS`, con attesa crescente fino a
  10 minuti sui fallimenti consecutivi.
- `invia.ts` — risponde **sempre da `MAIL_USER`**: la casella che riceve deve
  essere la stessa identità che risponde, altrimenti il relay del marketplace
  rifiuta e il thread si perde. Non è configurabile apposta.
- `routes/reply.ts` — due modi di autenticarsi: `WORKER_API_TOKEN` per
  automazioni da server a server, oppure `Authorization: Bearer <sessione
  Supabase>` per l'agente che scrive dall'interfaccia — verificata chiedendo
  a Supabase Auth di chi è il token, mai un segreto statico nel browser.
  **Senza ALMENO UNO dei due la rotta non viene registrata**: un endpoint
  aperto che spedisce dall'identità venditore è troppo pericoloso per
  essere il default. Con una sessione agente, `agent_id` nel corpo viene
  ignorato e sostituito da quello vero: altrimenti chiunque potrebbe
  firmare l'invio col nome di un collega.
- **CORS** (`server.ts`): senza `INTERFACCIA_ORIGINS` (origini separate da virgola)
  il browser di Lovable blocca la chiamata a `/threads/reply` PRIMA che arrivi
  al server — non un 401, un errore di rete generico, diagnosticabile solo
  sapendo che manca questo. Nessun jolly: elenco esplicito, sono rotte con
  una sessione agente autenticata dietro.
- `core/policy.ts` — il guardiano dei contenuti, chiamato da `reply.ts`
  prima di ogni invio. Regole per genere di canale (`kind`), non per
  singolo account: su Amazon niente URL, contatti, richieste di recensione
  o inviti a contattare fuori piattaforma (in 5 lingue); su Mirakl niente
  contatti diretti; Shopify ed email restano senza restrizioni. Una
  violazione torna 422 con la porzione di testo incriminata, mai un
  rifiuto silenzioso.
  **Eccezione**: i link di tracciamento dei corrieri sono ammessi anche su
  Amazon — rispondono a "dov'è il mio pacco", non portano il cliente fuori
  piattaforma per altri scopi. Riconosciuti per dominio (`DOMINI_CORRIERE`,
  i più comuni in Italia e internazionali): un link che non corrisponde a
  nessuno di questi resta bloccato, anche mescolato a uno di tracciamento
  vero nello stesso messaggio.

- `ripulisci.ts` — riduce il corpo a ciò che ha scritto il cliente, togliendo
  l'impalcatura del relay. **Non restituisce mai il vuoto**: se non riconosce
  niente rende il testo originale, perché un corpo rumoroso si legge comunque
  mentre un corpo vuoto fa perdere il messaggio. L'integrale resta in `raw`.

### Allegati (migrazione 0008)
`core/storage.ts` carica i byte su Supabase Storage (bucket privato `allegati`,
REST diretto, non l'SDK — coerente con postgres.js: niente client pesante dove
basta una `fetch`). Serve `SUPABASE_URL` + `SUPABASE_SERVICE_ROLE_KEY`; senza,
l'allegato entra comunque ma solo come metadato, mai un'email persa per questo.

**In entrata (casella)**: `upsert.ts` carica ogni allegato **prima** di aprire
la transazione database — è I/O di rete, tenerla dentro una transazione
terrebbe lock aperti per tutto l'upload. Percorso `{account_code}/{checksum}-
{nome_file}`, upload idempotente (`x-upsert`). `core/immagine.ts` legge
larghezza e altezza con sharp per le miniature.

**DEBITO**: sharp/libvips di default non legge HEIC/HEIF in modo affidabile —
il formato delle foto iPhone. Oggi l'allegato HEIC si carica comunque (i byte
originali arrivano su Storage) ma senza dimensioni, e senza la conversione a
JPEG per la visualizzazione prevista dal runbook: resta da costruire, con una
libreria verificata per quel formato specifico, non assunta.

**In entrata (Mirakl)**: `client.ts` ha ora `download()` per M13
(`GET /inbox/threads/{attachment_id}/download`) — stesso DEBITO del resto del
connettore: percorso scritto sulla documentazione, non verificato su una
risposta reale. `upsert.ts` scarica ogni allegato PRIMA di aprire la
transazione, con lo stesso motivo della casella email; se il download fallisce
l'allegato entra comunque come solo metadato, mai un messaggio perso per
questo.

**In uscita**: `core/attachments/normalize.ts` converte e ricomprime prima di
spedire. Su Amazon: pdf/png/txt/doc/docx/tiff/bmp passano invariati; JPG viene
convertito in PNG (mai rifiutato — è il formato in cui arrivano le foto dai
telefoni); oltre i 6 MB si ricomprime (per un'immagine, riducendo i pixel:
un PNG non ha un parametro di qualità) puntando a 4 MB; un tipo non ammesso o
non ricomprimibile sotto soglia viene rifiutato con un motivo leggibile, mai
in silenzio. `POST /threads/reply` accetta ora `allegati: [{storage_path,
nome_file, mime}]` — riferimenti a file che l'interfaccia carica direttamente
su Supabase Storage, bucket `allegati`; il worker li scarica, li normalizza
per canale e SOLO se tutti passano procede con l'invio: un allegato rifiutato
blocca l'intero messaggio, l'agente non deve scoprire dopo che è partito solo
il testo. Il file davvero spedito (dopo un'eventuale conversione) viene
ricaricato su Storage e registrato in `attachment` con `direzione='out'`, per
mostrare in cronologia cosa il cliente ha ricevuto, non cosa l'agente aveva
scelto.

**In uscita (Mirakl)**: M12 accetta `multipart/form-data` con `message_input.body`
e `files[]` — letto dalla documentazione pubblica di Mirakl, non dal runbook
originale che indicava OR74 ("carica documenti per un ordine"): OR74 è a
livello di ordine, non di thread di messaggistica, e non è questo. `invia.ts`
sceglie da solo multipart quando ci sono allegati, JSON altrimenti — stesso
DEBITO del resto del connettore Mirakl: verificato sulla documentazione, non
ancora su un invio reale con file (nessun cliente Mirakl ha ancora scritto).

**Ancora da fare**: la policy RLS su `storage.objects` che permette a Lovable
di caricare i file in uscita direttamente (di competenza di Lovable, non di
questo repo — vedi migrazione 0008; già fornita, verificare che sia stata
eseguita).

**Cosa entra in coda** (`app_config.mail_ingest`, migrazioni 0003 e 0004):
`domini_esclusi` è una lista di **esclusi, non di ammessi** — scelta
deliberata. Con una lista di ammessi, il cliente che scrive direttamente da un
indirizzo nuovo sparirebbe in silenzio; con una di esclusi il caso peggiore è
un po' di rumore in coda, che si vede e si corregge. Il confronto è per
suffisso, quindi `google.com` copre tutti i suoi sottodomini — e `amazon.com`
(notifiche di mancata consegna) resta ben distinto da `marketplace.amazon.it`
(messaggi veri dei clienti).
`domini_notifica` è il terzo genere: gli avvisi di mancata consegna di Amazon
(`amazon.com`, non `marketplace.amazon.it`) non diventano ticket — non c'è
niente a cui rispondere — ma vengono annotati sulla conversazione di
quell'ordine, che prende il tag `consegna-fallita` e torna aperta. È
l'informazione che serve dove serve: quel cliente non ha ricevuto la risposta.
Una notifica che non si aggancia finisce in `ingest_anomaly`, non nel nulla.

`domini_avviso` è il quarto genere, ed è il più importante: richieste di
garanzia dalla A alla Z e richieste di rimborso con azione richiesta. Non le
scrive il cliente, ma sono la cosa più urgente che passa dalla casella — una
A-to-Z non gestita pesa sulla salute dell'account e **per quelle non esiste
API**: l'email è l'unico modo di saperlo. Entrano con SLA corta (240 minuti) e
aprono la conversazione dell'ordine se non c'è.

`riaggancia.ts` — **l'aggancio si riprova a ogni giro.** Un messaggio può
arrivare prima del suo ordine: gli ordini Amazon non passano dallo Shopify (a
un controllo su dati veri, 1406 messaggi su 1438 citavano un numero d'ordine e
**zero** di quegli ordini erano in archivio), e anche a sincronizzazione
accesa una email può precedere il webhook. Un aggancio fatto una volta sola,
al momento dell'ingestione, sbaglierebbe per sempre. Così invece il giorno in
cui gli ordini arrivano, le conversazioni in attesa si sistemano da sole entro
un minuto.

**Precedenza — la parte delicata.** L'ordine è: escluso → canale riconosciuto →
avviso → notifica → messaggio. Il passaggio "canale riconosciuto" viene PRIMA
delle liste per genere perché il dominio del relay dei clienti è un
sottodominio di quello degli avvisi: senza, tutti i messaggi dei clienti
diventerebbero avvisi e il canale principale si spegnerebbe in silenzio.
C'è un test che tiene separati i due casi, ed è stato quel test a scoprire il
bug la prima volta.

E le email più vecchie di `giorni_coda` entrano già `closed`: la prima lettura
importò tre mesi di storico e produsse 371 ticket "in ritardo di 2000 ore",
che nascondevano i pochi a cui rispondere oggi.

**Fixture:** `amazon-messaggio-reale.eml` ha il corpo vero (headers ricostruiti);
gli altri file in `test/fixtures/mail/` sono sintetici — vedi il LEGGIMI lì
dentro. Per questo il codice non interpreta la semantica del corpo: si aggancia
all'alias e, come ripiego, al numero d'ordine, che ha una forma fissa.

### Connettore Mirakl (passo 06)
API vera, al contrario di Amazon: **M11** `GET /api/inbox/threads` per leggere
(`updated_since` + paginazione a cursore), **M12**
`POST /api/inbox/threads/{id}/message` per rispondere.

**Autenticazione**: `Authorization: <chiave>`, senza `Bearer`. Verificato con
una chiamata reale (200), non dedotto: la documentazione pubblica lo chiama
"Shop-API-Key" e non mostra il formato.

**Configurazione**: l'URL sta in `channel_account.config.endpoint`, il NOME
della variabile con la chiave in `channel_account.secret_ref`, la chiave
nell'ambiente. Un operatore in più = una riga di SQL più una variabile; nel
codice non c'è nessun URL di nessun cliente.

**L'aggancio all'ordine qui è esatto**: l'entità `MMP_ORDER` del thread porta
l'identificativo, che è lo stesso `external_order_id` importato da Shopify.
Nessun testo da interpretare — al contrario di Amazon, dove il numero va
cercato nell'oggetto o nel corpo.

**DEBITO IMPORTANTE — scritto sulla documentazione, non su risposte vere.**
Quando è stato costruito nessun cliente Mirakl aveva ancora scritto e l'API
restituiva `{"data":[]}`. Per questo il normalizzatore è tollerante e
*loquace*: ogni scostamento dallo schema atteso finisce in `ingest_anomaly`
con tipo `mirakl_*` invece di rompersi o, peggio, di essere ignorato. Il punto
più incerto è `from.type`, da cui dipende il verso del messaggio: i valori
considerati "nostri" stanno in `MITTENTI_NOSTRI_PREDEFINITI` e i tipi
sconosciuti vengono registrati.

Al primo messaggio vero, il collaudo è un comando:
```
npm run mirakl:check -- --forma
```
Non scrive nulla: stampa i nomi dei campi che l'API restituisce davvero, li
confronta con quelli attesi e non mostra il contenuto dei messaggi.

Prossimo passo: classificazione dell'intento e bozze AI.
