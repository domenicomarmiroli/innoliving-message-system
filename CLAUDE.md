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
`graph:subscribe`, `graph:delta`, `ricambi:deriva`, `instance:init`,
`instance:export`, `eval:classify`.

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
  **Indirizzi** (`shipping_address`/`billing_address`, migrazione 0013):
  stessi nomi di campo in REST e GraphQL per queste chiavi (`address1`,
  `city`, `zip`, `country`, `phone`, `name`), un solo estrattore per
  entrambi. Per ordine, non per cliente: un cliente può farsi spedire un
  ordine a un indirizzo diverso dal solito (regalo, seconda casa). Gli
  ordini importati prima di questa migrazione restano con questi campi
  `null` finché il giro periodico o un nuovo backfill non li ripassa —
  non è un dato perso, prima non veniva proprio richiesto a Shopify.
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

**✅ Bug corretto (03/09): gli ordini Amazon finivano su `channel='shopify'`.**
Domenico ha segnalato che il match ticket↔ordine sembrava non funzionare
per Amazon, sapendo che il negozio importa questi ordini con nome
`INSHxxxx` mentre il vero numero Amazon vive nel campo "Channel
Information → Order ID" che l'admin Shopify mostra per gli ordini
arrivati da un marketplace.

**Verificato via MCP Shopify sui dati reali dello store** (non
sull'ipotesi): quel campo corrisponde a `Order.sourceIdentifier` nella
Admin GraphQL API, duplicato anche nell'attributo `"Amazon Order Id"`.
`riconosciCanale()` (`normalize.ts`) cercava invece il prefisso `AMZ`
nel `name` dell'ordine — corretto per un'integrazione Amazon precedente
(ordini reali con `name = "AMZ304-0904527-7250707"`, ancora in
archivio, tenuti come ripiego), ma gli ordini di oggi arrivano tramite
l'app **Marketplace Connect**: `name` resta `INSHxxxx` come qualunque
altro ordine, il canale si legge da `source_name` (`amazon`/`amazon-it`),
l'id vero da `source_identifier`. Senza questo, ogni ordine Amazon
sincronizzato da quando è attiva Marketplace Connect finiva silenziosamente
su `channel='shopify'` con `external_order_id` uguale al nome interno del
negozio — irraggiungibile da un'email che cita il numero Amazon vero.

Corretto in `riconosciCanale()`: riconoscimento primario da `source_name`
che inizia per `amazon`, id da `source_identifier` (ripiego
sull'attributo `"Amazon Order Id"`); il vecchio riconoscimento dal
prefisso `AMZ` resta secondo, per gli ordini storici.

**Dati già in archivio, corretti con una query mirata via MCP Supabase**
(non un reprocessing da zero — il payload originale in `raw` bastava):
413 ordini `channel='shopify'` con `source_name` Amazon nel loro `raw`.
405 senza conflitti: `channel`/`external_order_id` corretti sul posto. 8
in conflitto con una riga `channel='amazon'` già esistente — un
segnaposto creato da `resi.ts`/`rimborsi.ts` quando un reso o un
rimborso Amazon era arrivato prima che l'ordine si sincronizzasse da
Shopify (stesso meccanismo di 28/08): per questi, i campi Shopify (righe
prodotto, tracking, indirizzi, totale) sono stati uniti sul segnaposto —
senza toccare `reso_*`/`rimborso_*`/`reclamo_az_*`, che restano quelli
del segnaposto — e la riga Shopify duplicata cancellata, dopo aver
verificato che nessun `thread.order_id` la referenziasse. Nessuna
migrazione di schema: solo dati. **Non serve toccare `thread`**:
`riaggancia.ts` ritrova da solo, al primo giro dopo il deploy, le
conversazioni `unmatched` che citano questi numeri d'ordine — stesso
comportamento già visto per il problema strutturale del 26/08.

**✅ VERIFICATO da Domenico su un ticket reale**, subito dopo il deploy:
l'ordine Amazon compare ora nel pannello di contesto.

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
  **Lovable ha DUE origini diverse da autorizzare**, scoperto quando il
  pulsante "Genera bozza" sembrava rotto dall'editor ma funzionava dal sito
  pubblicato: il sito pubblicato/anteprima (`*.lovable.app`) e l'iframe di
  anteprima dentro l'editor stesso, un dominio del tutto diverso
  (`*.lovableproject.com`, con l'id del progetto). Mancava la seconda.
- `core/policy.ts` — il guardiano dei contenuti, chiamato da `reply.ts`
  prima di ogni invio. Regole per genere di canale (`kind`), non per
  singolo account: su Amazon niente URL, contatti, richieste di recensione
  o inviti a contattare fuori piattaforma (in 5 lingue); su Mirakl niente
  contatti diretti; Shopify ed email restano senza restrizioni. Una
  violazione **bloccante** torna 422 con la porzione di testo incriminata,
  mai un rifiuto silenzioso.
  **Eccezione**: i link di tracciamento dei corrieri sono ammessi anche su
  Amazon — rispondono a "dov'è il mio pacco", non portano il cliente fuori
  piattaforma per altri scopi. Riconosciuti per dominio (`DOMINI_CORRIERE`,
  i più comuni in Italia e internazionali): un link che non corrisponde a
  nessuno di questi resta bloccato, anche mescolato a uno di tracciamento
  vero nello stesso messaggio.
  **Stessa eccezione per i link ad Amazon stessa (29/08, su un caso
  reale)**: Domenico ha segnalato un link a una pagina di aiuto Amazon
  (`amazon.it/gp/help/...`) bloccato come fuori piattaforma — ma è
  Amazon stessa, la regola vieta di portare il cliente FUORI da Amazon,
  non di linkare pagine di Amazon. `DOMINI_AMAZON` (i domini principali
  per paese) segue lo stesso schema di `DOMINI_CORRIERE`.
  **Altra eccezione, stessa logica di `core/ai/redazione.ts`**: il
  controllo sul telefono non scambia più un numero d'ordine Amazon (tre
  cifre-sette cifre-sette cifre, es. `405-0668977-2033157`) per un
  contatto — trovato quando una bozza AI l'ha citato per chiedere
  conferma di un ordine non ancora in archivio e la policy l'ha bloccata
  per errore.
  **Ogni `Violazione` ha `bloccante: boolean` (27/08).** Il telefono è
  l'unica non bloccante oggi: verificato da Domenico che Amazon non lo
  rifiuta davvero lato suo, la nostra regola era più prudente della
  piattaforma al punto da impedire un caso legittimo (es. "chiami il
  centro assistenza per la sostituzione"). `EsitoPolicy.ok` è `false`
  solo se c'è almeno una violazione bloccante — un telefono da solo non
  impedisce più l'invio. `POST /threads/reply`, quando l'invio riesce,
  restituisce comunque le violazioni non bloccanti in `avvisi`: l'agente
  deve vederle lo stesso, un avviso silenzioso sarebbe lo stesso errore di
  un rifiuto silenzioso. **Lato Lovable**: manca ancora mostrare
  `avvisi` come avviso non bloccante dopo un invio riuscito (oggi la 200
  è trattata come successo senza guardare il campo) — prossimo passo.

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

### Note interne (migrazione 0009)
`message.interno` distingue un appunto fra operatori da un messaggio vero: non
esce mai verso il marketplace. Come tag/assegnazione/stato, è un dato
puramente interno — si scrive direttamente su Supabase (message + eventuali
attachment collegati), mai tramite il worker, con la stessa policy RLS di
INSERT già prevista per quelle scritture.

**Regola per chi tocca il passo 07 (bozze AI) o qualunque cosa componga testo
verso il cliente o verso un modello**: le righe con `interno = true` vanno
SEMPRE escluse. Stessa logica della regola 8 su IBAN e dati personali fuori
dai prompt, applicata a un'intera categoria di messaggi.

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

### Richieste di reso Amazon (migrazione 0018)
Amazon manda una notifica quando un cliente apre una richiesta di reso, con
header `X-Space-Notification-Type: RETURN_REQUEST` — segnale più affidabile
del dominio del mittente, che Amazon condivide fra più tipi di notifica
(`amazon.com` porta sia queste sia gli avvisi di mancata consegna).
`classificaMittente()` (`riconosci.ts`) restituisce il genere `'reso'`
guardando questo header PRIMA delle liste per dominio: senza, una richiesta
di reso verrebbe scambiata per una notifica di mancata consegna e
riaprirebbe il thread sbagliato con il messaggio sbagliato.

`src/connectors/mail/resi.ts` — stesso schema di `registraAvviso()` in
`notifica.ts`: annota la conversazione dell'ordine esistente (non ne apre
una parallela), tag `reso-richiesto`. `estraiDatiReso()` legge dalla stessa
email sia i dettagli del reso (prodotto/ASIN/SKU/quantità/motivo/commento
del cliente, dalla tabella HTML) sia — se Amazon l'ha già emessa —
l'etichetta di spedizione di rientro (corriere e numero di tracciamento):
sono la STESSA email, non due separate, verificato sull'esemplare reale
(`test/fixtures/mail/amazon-richiesta-reso-reale.eml`, per l'ordine
403-1049451-9270721) prima di assumere il contrario.

Corriere e tracking del reso finiscono in `order.reso_carrier` /
`order.reso_tracking_number` — colonne distinte da `carrier`/
`tracking_number`, che tracciano la spedizione IN USCITA verso il cliente,
non quella di rientro: nel frontend sono due sezioni diverse.

**Ordine non ancora in archivio (28/08, sulla scorta di un caso reale)**:
tre rimborsi veri arrivati lo stesso giorno per ordini Amazon non ancora
sincronizzati da Shopify finivano in `ingest_anomaly`, persi — e persi
per sempre, perché un reso/rimborso "orfano" non crea un thread da
riagganciare più tardi (a differenza di un messaggio cliente, che resta
`unmatched` e viene riprovato ad ogni giro da `riaggancia.ts`).
`resi.ts`/`rimborsi.ts` ora creano un ordine SEGNAPOSTO (solo `channel`
e `external_order_id`, `insert ... on conflict (channel,
external_order_id) do update`) invece di arrendersi: quando l'ordine
vero arriva da Shopify, `upsertOrdine()` fa `ON CONFLICT` sulla STESSA
riga (stesso vincolo unique) e ne completa i campi — senza toccare
`reso_carrier`/`reso_richiesto_at`/`rimborso_totale`/`rimborso_emesso_at`
(non fanno parte della sua `SET`) e senza duplicare il thread, perché
la sua chiave usa `order.id`, che resta lo stesso prima e dopo. Se in
seguito un cliente scrive di quell'ordine, `aggancia()` lo trova per
`external_order_id` e finisce nello STESSO thread già annotato.
**Non risolve i tre casi già finiti in `ingest_anomaly` prima di questo
fix** — quelli restano lì, servirebbe rileggerli da IMAP per il loro
`rfc822_id` salvato nel payload, non fatto in automatico.

**`order.reso_richiesto_at` (migrazione 0020, 28/08)**: quando è arrivata
la notifica di reso, indipendente da corriere/tracking — un cliente può
aprire un reso prima che Amazon emetta l'etichetta, e senza questa colonna
il pannello "Reso" spariva del tutto in quel caso, perdendo l'informazione
più importante. `registraReso()` la valorizza sempre (con `coalesce`, non
sovrascrive una data già vista), a prescindere da corriere/tracking. È
sull'**ordine**, non sul thread: visibile su qualunque ticket collegato a
quell'ordine, non solo su quello che ha ricevuto l'email.

**`thread.closed_at` (migrazione 0020)**: scritta da un trigger
(`thread_set_closed_at`) al passaggio a `state = 'closed'`, azzerata alla
riapertura — non a mano da Lovable, così resta corretta indipendentemente
da quale punto dell'interfaccia cambia lo stato. Serve alla vista "Chiusi",
ordinata per data di chiusura discendente invece che per scadenza SLA
(che per un ticket già chiuso non ha più senso): l'ultimo gestito in cima.

### Rimborsi emessi Amazon (migrazione 0021)
Stesso meccanismo dei resi, header diverso: `X-Space-Notification-Type:
REFUND_ISSUED`. Riconosciuto in `classificaMittente()` con la stessa
precedenza (prima delle liste per dominio, stesso motivo — condivide
`amazon.com` con le notifiche di mancata consegna).

`src/connectors/mail/rimborsi.ts` — **differenza importante rispetto a
`resi.ts`**: un rimborso può ripetersi più volte sullo stesso ordine
(rimborsi parziali su articoli diversi, in email diverse nel tempo), quindi
non si può saltare l'elaborazione in base a un tag già presente sul thread
come fa `registraReso`/`registraAvviso` — un secondo rimborso vero
verrebbe scartato come "già visto". L'unica difesa contro il duplicato è
il vincolo unique su `rfc822_id`: l'insert del messaggio avviene PRIMA
dell'aggiornamento dell'ordine, e solo se l'insert ha davvero inserito una
riga nuova (non un conflitto) si somma l'importo — così la stessa email
rientrata due volte nel ciclo di lettura non conta due volte, ma due
email di rimborso diverse per lo stesso ordine sommano entrambe.

**Bug corretto (28/08, su un rimborso reale)**: `coalesce(importo, 0)` falliva con `invalid input
syntax for type integer` su qualunque importo con decimali (es. 56,95€) — il letterale `0` senza
virgola fa dedurre a Postgres che il parametro sia `integer`, non `numeric`. I rimborsi con importo
intero (es. 169€) erano passati per caso, mascherando il problema. Corretto con un cast esplicito
sul parametro (`::numeric`) prima del `coalesce`.

**Secondo bug corretto (28/08, quattro rimborsi reali dopo il primo fix)**: l'importo tornava
sempre `null` — non 0,00 per un errore di calcolo, ma perché `estraiImporto()` non trovava
nessuna corrispondenza. Un secondo esemplare reale (ordine 407-4153246-8419525,
`amazon-rimborso-emesso-reale-2.eml`) ha rivelato **due** differenze insieme, non una:
1. la frase è "abbiamo avviato un rimborso **dell'importo** di EUR 39.9", non "rimborso di
   EUR 39.9" come nel primo esemplare — la regex richiedeva le due parole adiacenti. Corretta
   con `[^.]{0,25}?` fra "rimborso" e "di": assorbe le parole in più senza richiedere che siano
   sempre le stesse, delimitato da un punto per non scivolare su una frase successiva.
2. la tabella degli articoli ha **solo tre colonne** (quantità/articolo/ASIN, quantità PRIMA,
   non dopo) invece delle sette del primo esemplare — la mappatura per posizione fissa
   avrebbe scambiato "quantità" per "prodotto". Corretto leggendo le intestazioni invece di
   assumere una posizione: nuova `estraiTabellaConIntestazioni()`/`indiceColonna()` in
   `core/html.ts`, usata solo da `rimborsi.ts` (resi.ts resta sulla mappatura fissa, unico
   esemplare visto finora — se un giorno servirà, si cambia con la stessa evidenza, non prima).

`order.rimborso_totale` è quindi una **somma cumulativa**, non l'ultimo
importo visto; `order.rimborso_emesso_at` è la data dell'ultimo. Entrambe
sull'ordine, non sul thread — stesso motivo di `reso_richiesto_at`:
visibili su qualunque ticket collegato.

`src/connectors/mail/html.ts` — le funzioni di estrazione HTML
(`testoPulito`, `campoEtichettaGrassetto`, `campoEtichettaSemplice`,
`estraiRigheTabella`) sono condivise fra `resi.ts` e `rimborsi.ts`:
stessa impaginazione a lista + tabella in entrambi i formati Amazon.

Verificato su un'email reale — vedi
`test/fixtures/mail/amazon-rimborso-emesso-reale.eml`, ordine
405-8567267-4113132 — non scritto sulla sola documentazione: qui la
documentazione pubblica di Amazon non esiste nemmeno, come per i resi.

**`message.tipo_evento` / `message.importo` / `message.importo_valuta`
(migrazione 0022)**: servono alla dashboard per contare resi e rimborsi
giorno per giorno. `v_tag_giornalieri` (migrazione 0015) non basta: è per
thread, datata su `thread.created_at` (quando il thread è nato, non
quando l'evento specifico è successo), e un thread può accumulare più
tag nel tempo senza contarne le occorrenze ripetute — inadatto a un
trend di eventi che si ripetono (i rimborsi parziali). `tipo_evento`
('reso_richiesto' | 'rimborso_emesso', null altrove) distingue questi
messaggi-annotazione da quelli generati da `registraAvviso`/
`registraNotifica`, che hanno la stessa forma strutturale (`author_kind
= 'system'`, `match_strategy = 'numero_ordine'`) ma nessun discriminatore
prima d'ora. `importo`/`importo_valuta` sono l'importo di QUEL singolo
evento (non cumulativo, a differenza di `order.rimborso_totale`): la
dashboard somma per periodo, raggruppando per valuta — mai sommando
valute diverse fra loro.

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

**✅ COLLAUDATO SU DATI VERI (27/08)**: Leroy Merlin France (Adeo,
`mirakl-lmfr`) è il primo cliente Mirakl reale che scrive in questo
sistema. Primo giro dopo l'attivazione: **1.558 messaggi** inseriti, zero
errori — il debito "scritto sulla documentazione, non su risposte vere"
si è ridotto parecchio, restano da collaudare solo gli allegati in
entrata/uscita (nessuno ancora arrivato con un file).

Tre cose scoperte proprio su questo primo collaudo, tutte corrette:

1. **`from.type` — tre valori reali**: `SHOP_USER` (siamo noi, ora in
   `MITTENTI_NOSTRI_PREDEFINITI` insieme a `SHOP`/`SELLER`/`STORE`),
   `CUSTOMER_USER` (il cliente, comportamento di default già corretto),
   `OPERATOR_USER` (**il marketplace stesso**, non il cliente — verificato
   sul contenuto reale: mittente "Operator", notifiche automatiche tipo
   "hai ricevuto una richiesta di fattura", indirizzate al negozio). I
   valori del marketplace stanno in `MITTENTI_MARKETPLACE_PREDEFINITI` e
   producono `author_kind = 'system'` — la colonna esisteva già nello
   schema, inutilizzata: era pensata esattamente per questo caso. Un tipo
   davvero ignoto (né nostro né marketplace) resta `customer` per
   prudenza e finisce comunque in `ingest_anomaly`.

2. **M12 non accetta JSON** — solo `multipart/form-data`, in ogni caso,
   anche senza allegati. Il ramo JSON che il connettore usava per i
   messaggi senza allegati non avrebbe mai potuto funzionare: non è mai
   stato eseguito prima d'ora, quindi non aveva ancora fatto danni, ma
   sarebbe fallito al primo invio reale senza file. Ora `invia.ts` usa
   sempre multipart.

3. **`message_input.to` è obbligatorio**, non facoltativo: senza, l'API
   rifiuta la richiesta. Un thread può avere due controparti — il
   cliente e l'operatore del marketplace (vedi sopra) — e l'agente deve
   poter scegliere a chi rispondere, come sul portale Mirakl. Di default
   si risponde solo al cliente (`DestinatarioMirakl`, in `invia.ts`);
   `/threads/reply` accetta `mirakl_destinatari` (facoltativo, solo per
   thread Mirakl) per scegliere `CUSTOMER`, `OPERATOR`, o entrambi. Vale
   per qualunque operatore Mirakl, non solo Leroy Merlin — stessa API per
   tutti. **Lato Lovable**: manca ancora il selettore nell'editor di
   risposta per i thread Mirakl — prossimo passo.

**✅ Quarto bug, trovato sul primo INVIO reale (28/08, non più solo
lettura).** I tre punti sopra vengono dalla lettura dei messaggi in
arrivo; il primo tentativo di rispondere a un thread Leroy Merlin ha
fallito con `502` e, nei log, `400 - Required part 'message_input' is
not present`. Il codice mandava campi appiattiti
(`message_input.body`, `message_input.to[0].type`), ma M12 cerca una
SINGOLA parte multipart chiamata esattamente `message_input`, con
dentro il JSON intero — la stessa forma della sintassi documentata da
Mirakl (`-F "message_input=@message_input.json;type=application/json"`).
Corretto con `costruisciMessageInput()` in `invia.ts`, che costruisce
l'oggetto `{ body, to }` come una parte unica. Il debito "verificato
sulla documentazione, non su un invio reale" era già ridotto dalla
lettura; ora anche la scrittura è passata da un tentativo vero.

**✅ Quinto bug, trovato su un caso reale (31/08): risposte duplicate in
interfaccia.** Domenico ha segnalato che ogni risposta a un thread
Leroy Merlin compariva due volte, stessa bolla, stesso testo, stesso
minuto. Log di Render: il nostro invio (`risposta Mirakl inviata`) e,
12 secondi dopo, il giro di sincronizzazione periodica ha inserito un
messaggio nuovo sullo stesso thread (`mirakl_messaggi: 1`) — la stessa
risposta, reimportata. Causa: M12 (scrittura, `invia.ts`) e M11
(lettura, `upsert.ts`) non riportano lo stesso `external_id` per lo
stesso messaggio, quindi il vincolo `(thread_id, external_id)` non
basta a prevenire il doppione quando la sincronizzazione rilegge un
messaggio nostro appena spedito. Corretto in `upsert.ts`: per i
messaggi con `autore_kind = 'agent'`, prima dell'insert si controlla
anche se esiste già un nostro messaggio nello stesso thread con lo
stesso testo in una finestra di ±2 minuti — non solo lo stesso id.
**Lato Lovable**: nello stesso giro, `messagesQuery()` deduplica anche
lato interfaccia (per `id`, poi per impronta direzione+destinatari+
minuto+testo) — doppia difesa, non l'una al posto dell'altra.

**✅ Sesto bug, trovato su un secondo operatore reale (01/09): un
operatore non riceveva mai i messaggi, in silenzio.** Domenico ha
segnalato un messaggio visto sul portale Mirakl di un secondo operatore
ma assente dalla nostra app. `sync_state` mostrava sincronizzazioni
riuscite regolarmente, zero errori: la connessione era sana. Ma
`thread`/`message` per quell'account erano completamente vuoti da
sempre, e anche `ingest_anomaly` — non un dato scartato, mai arrivato.

**Prima ipotesi, insufficiente**: la richiesta M11 filtrava sempre con
`entity_type: 'MMP_ORDER'`, mentre il normalizzatore (`ENTITA_ORDINE`
in `normalize.ts`) accetta anche `MPS_ORDER` — tolto il filtro (resta
tolto: Mirakl stesso sconsiglia di passare `entity_type` senza un
`entity_id` specifico, rischio 400), ma dopo il fix l'operatore
continuava a ricevere `200` con `data: []` anche su una richiesta senza
alcun filtro. Non era la causa.

**Causa vera, confermata dal supporto Mirakl dell'operatore**: un
utente con accesso a più shop, se non passa `shop_id` esplicito in M11,
interroga lo shop "di default" — che può non essere quello con le
conversazioni reali. Nessun errore lo rivela: è una richiesta
legittima, risponde 200 con una lista vuota. Stessa causa sospettata
all'inizio per la chiave API o l'endpoint sbagliati (entrambi
verificati corretti) — era invece lo scope implicito della chiave.

**Fatto**: `channel_account.config.shop_id` (facoltativo, letto in
`costruisciOperatori()`) — se presente, va nella richiesta M11 come
`shop_id`; se assente il comportamento è quello di sempre, non
cambia nulla per un operatore a shop singolo come Leroy Merlin. Il
comando di collaudo `mirakl:check -- --forma` ora chiama anche A01
(`GET /api/account`) prima di leggere i thread e stampa lo `shop_id`
reale dell'account — così si scopre il valore giusto da mettere in
configurazione senza andarlo a cercare a mano nel pannello Mirakl, e
segnala un'eventuale discrepanza con quello già configurato. Non c'è
un endpoint self-service per elencare gli shop di un account
multi-shop (confermato dal supporto Mirakl dell'operatore): lo
`shop_id` di uno shop diverso da quello primario va sempre richiesto
al marketplace stesso.

**✅ RISOLTO (01/09).** Shop primario della chiave: 4998 ("Innoliving
DE", sospeso). Shop vero, con le conversazioni reali: 5079 ("Innoliving
IT"), ottenuto dal supporto MediaMarktSaturn e impostato in
`config.shop_id`. Con lo shop giusto, M11 ha risposto subito con dati
veri — stesso `id` di thread già visto dall'URL di un messaggio sul
portale. **Effetto collaterale trovato collaudando su questi dati
reali**: `from.type = "CUSTOMER_USER"` (il cliente, il caso più comune
di tutti) veniva classificato correttamente come `autore_kind =
'customer'` ma registrato comunque come tipo ignoto in
`ingest_anomaly` — mancava da una lista di valori riconosciuti che
copriva solo noi (`MITTENTI_NOSTRI_PREDEFINITI`) e il marketplace
(`MITTENTI_MARKETPLACE_PREDEFINITI`), mai il cliente. Aggiunta
`MITTENTI_CLIENTE_PREDEFINITI = ['CUSTOMER_USER']` in `normalize.ts`:
un cliente riconosciuto non genera più rumore, un tipo davvero nuovo
continua a essere segnalato come prima.

**Settimo bug, stessa causa dal lato opposto: l'invio (M12) restava
sullo shop sbagliato anche dopo il fix della lettura.** Il primo
tentativo reale di rispondere a un thread di un operatore multi-shop
ha dato lo stesso 502 già visto con Leroy Merlin il 28/08 — ma qui la
causa era diversa: `postMultipart()` (`client.ts`, usato da `invia.ts`
per M12) non accettava parametri di query, quindi `shop_id` non veniva
mai passato in scrittura anche se già letto correttamente da
`costruisciOperatori()` — la richiesta scriveva sempre sullo shop di
default (quello sospeso), indipendentemente dal thread. Il fix di
lettura (M11) non copriva la scrittura: due punti diversi dello stesso
client, corretti separatamente. `postMultipart()` ora accetta un
parametro `parametri` come `get()`; `invia.ts` passa `shop_id:
operatore.shop_id` a ogni invio. 169 test verdi, incluso uno che
verifica lo `shop_id` nell'URL della POST multipart.

**`message.mirakl_destinatari` (migrazione 0019, 28/08)**: a chi è
andata davvero una risposta Mirakl (`CUSTOMER`, `OPERATOR`, o entrambi),
salvato sulla riga a ogni invio — scoperto mancante quando Domenico ha
mandato una risposta a cliente+operatore insieme e non c'era modo, dalla
cronologia, di sapere a chi fosse andata. Lato Lovable, ogni bolla in
uscita che valorizza il campo mostra "A: Cliente" / "A: Operatore" / "A:
Cliente e Operatore"; null (canali non-Mirakl, o messaggi Mirakl spediti
prima di questa migrazione) non mostra etichetta.

**Corpo HTML dei messaggi (28/08)**: Domenico ha segnalato una bolla con
i tag grezzi in vista (`<b>`, `<ul>`, `<a>`...) su una notifica di
sistema Leroy Merlin/Adeo ("richiesta di fattura", mittente
`OPERATOR_USER`). Causa: Mirakl manda `body` in HTML per questi
messaggi, ma finiva intero in `message.body_text`. `normalize.ts`
(`separaCorpo()`) ora rileva quando il corpo contiene un tag vero
(non solo un carattere `<` isolato — un messaggio scritto a mano da un
cliente non deve vedersi comprimere gli a-capo da `testoPulito` per
errore) e lo divide: `corpo_testo` (sempre, con `testoPulito` di
`core/html.ts` se il corpo era HTML) va in `body_text`; `corpo_html`
(solo quando c'era markup, altrimenti null) va in `body_html`.
**Beneficio collaterale**: i messaggi di sistema Mirakl con HTML non
inquinano più il contesto delle bozze AI con tag grezzi, visto che
`generaBozza` legge da `body_text`.

`core/html.ts` (spostato da `connectors/mail/`, ora condiviso anche dal
connettore Mirakl) — solo `testoPulito()` serve qui; le altre funzioni
restano specifiche del formato a lista + tabella delle notifiche Amazon.

Lato Lovable: la bolla mostra `body_html` (sanificato con DOMPurify,
lista di tag ristretta, link solo `http`/`https` con `target="_blank"
rel="noopener noreferrer"`) al posto di `body_text` SOLO quando il
canale è Mirakl e il campo è valorizzato — email e Shopify continuano a
mostrare solo `body_text` come sempre (il loro `body_html` è l'HTML
grezzo dell'email intera, mai da mostrare direttamente).

Per un nuovo operatore, lo stesso collaudo:
```
npm run mirakl:check -- --forma
```
Non scrive nulla: stampa i nomi dei campi che l'API restituisce davvero, li
confronta con quelli attesi e non mostra il contenuto dei messaggi.
Ma il vero collaudo, come dimostrato qui, è il primo cliente che scrive.

### Reclami di Garanzia dalla A alla Z (migrazione 0024)
Stesso meccanismo di resi e rimborsi, header `X-Space-Notification-Type:
A_Z_CLAIM_RESPONDENT_NOTIFY`. **Qui l'header non è solo più affidabile del
dominio — è l'unico modo corretto**: verificato su un esemplare reale che
l'oggetto di questa email ("Richiesta di rimborso ricevuta per l'ordine
...") non contiene "dalla A alla Z" da nessuna parte, solo il corpo lo
dice. Il vecchio meccanismo `avviso` (migrazione 0007, per testo
nell'oggetto) avrebbe classificato questa email col tag generico
`avviso-piattaforma`, perdendo l'urgenza specifica — un reclamo A-to-Z
pesa sulla salute dell'account venditore, non è un avviso qualunque.

`src/connectors/mail/reclami.ts` — stesso schema di `resi.ts`, incluso
l'ordine segnaposto quando non ancora in archivio. `estraiDatiReclamo()`
legge importo e termine di risposta dal corpo: **l'importo è in formato
italiano** (virgola come separatore decimale, es. "119,00"), a
differenza dei rimborsi che usano il formato americano ("169.01") — non
sono la stessa convenzione, verificato sui due esemplari reali, non
assunto uguale.

`order.reclamo_az_importo` / `order.reclamo_az_ricevuto_at`: un evento
per ordine (coalesce mantiene la prima data), non cumulativo come i
rimborsi — un reclamo non si ripete nello stesso modo di un rimborso
parziale.

**DEBITO dichiarato**: verificato solo l'esemplare della notifica
iniziale del reclamo. Amazon promette una seconda email quando prende
una decisione ("Non appena prenderemo una decisione, invieremo...");
probabilmente con lo stesso header, ma il formato non è stato ancora
visto. Oggi ogni notifica con questo header viene trattata come un
evento indipendente (stesso dedup per `rfc822_id` di tutti gli altri
moduli) — non perde niente, ma non distingue ancora "reclamo aperto" da
"decisione presa".

### Ticket collegati — "linked tickets" stile Zendesk (migrazione 0026, 03/09)
Richiesto da Domenico: dal ticket cliente, poter scrivere una email a un
indirizzo esterno (corriere, assistenza) senza uscire dal sistema, con
un nuovo ticket che nasce **in attesa** e resta **collegato** a quello di
partenza, visibile nella barra laterale — come i linked tickets di
Zendesk.

`thread.linked_thread_id` (migrazione 0026): un solo campo, sul thread
"figlio" (verso corriere/assistenza), che punta al thread "padre" (il
ticket cliente). Per i figli di un padre si interroga al contrario
(`where linked_thread_id = :padre_id`) — nessuna tabella di collegamento
in più, un padre può avere più figli, un figlio ha un solo padre.

**Stato "in attesa"**: riusa `pending_internal`, presente nel vincolo di
`thread.state` fin dalla migrazione 0001 ma **mai scritto da nessun
codice** fino ad oggi — era esattamente il posto pensato per "in attesa
di qualcuno che non è il cliente".

`src/connectors/mail/collega.ts` — `apriTicketCollegato()`: crea il
nuovo thread (`account_id` = l'unico `channel_account` con `kind='email'`,
stesso account di ogni altra email; `order_id` ereditato dal padre;
`assignee_id` = l'agente che scrive, o quello del padre come ripiego) e
spedisce il primo messaggio via SMTP, **prima** di aprire la transazione
— stessa regola di `upsert.ts` per l'I/O di rete. `tags` prende
`'ticket-collegato'` + `'collegato-<tipo>'` (`tipo` è `corriere` |
`assistenza` | `altro`, solo per etichetta/tag — non una colonna nuova,
stessa scelta già fatta altrove nel progetto). `due_at` usa lo
`sla_minutes` della casella: un corriere che non risponde compare anche
nella vista "In scadenza".

**La risposta del corriere si aggancia da sola, nessun codice di
matching nuovo**: `aggancia.ts` (strategia THREAD) collega qualunque
email in arrivo il cui In-Reply-To/References punti a un `rfc822_id`
nostro già in `message`, indipendentemente dal canale — basta aver
registrato il nostro invio con quel `rfc822_id` nel nuovo thread. Le
risposte successive dell'agente (continuare a scrivere al corriere)
passano dal normale `POST /threads/reply` → `inviaRisposta()`, che
funziona su qualunque thread `kind='email'`: nessuna modifica lì.

**Bug corretto nello stesso giro, prima che potesse manifestarsi**:
`upsert.ts` riapriva un thread (`state → 'open'`) su una nuova email in
arrivo solo per `state in ('closed', 'pending_customer')`.
`pending_internal` non c'era — senza il fix, la risposta del corriere si
sarebbe agganciata al thread giusto ma il ticket sarebbe rimasto "in
attesa" per sempre, invisibile a chi deve agire. Aggiunto
`'pending_internal'` alla stessa lista.

`POST /threads/collega` (`src/routes/collega.ts`) — stessa doppia
autenticazione di `/threads/reply` (WORKER_API_TOKEN o sessione
Supabase), stessa gestione allegati (`prepare('email', ...)`, nessuna
restrizione) e stessa policy di contenuto (`verificaPolicy('email',
...)`, oggi sempre `ok: true` — email non ha regole). Corpo: `thread_id`
(il ticket cliente), `destinatario`, `testo`, `oggetto` facoltativo,
`tipo` facoltativo, `allegati` facoltativi. Risposta: `thread_id` del
**nuovo** ticket, `message_id`, `rfc822_id`.

**Lato Lovable**: scheda "Ticket collegati" nel pannello di contesto
(query su `linked_thread_id`), banner sul ticket figlio col link al
padre, azione "Contatta corriere/assistenza" che chiama
`/threads/collega`, etichetta "In attesa" per lo stato `pending_internal`.

**Bug corretto lo stesso giorno, trovato sul primo collaudo reale**:
rispondere una seconda volta su un ticket collegato appena aperto (prima
che corriere/assistenza avessero risposto) falliva con 502 —
`inviaRisposta()` in `invia.ts` cercava sempre l'ULTIMO MESSAGGIO IN
ARRIVO del thread per sapere a chi scrivere, ma un ticket collegato
nasce con un solo messaggio in USCITA: nessun messaggio in arrivo,
nessun destinatario trovato. Corretto con un ripiego: se non c'è nessun
messaggio in arrivo, si usa l'ultimo messaggio in USCITA e il suo
`raw.to` come destinatario — l'agente può continuare a scrivere allo
stesso indirizzo anche prima che risponda. **Stesso giro**: lo stato
dopo l'invio non torna più sempre `pending_customer` — su un thread con
`linked_thread_id` valorizzato torna `pending_internal`, perché non c'è
nessun cliente dall'altra parte e l'etichetta "in attesa del cliente"
sarebbe stata fuorviante.

### Bozze AI e knowledge base (passo 07, migrazione 0010)
`core/ai/` — un provider dietro un'interfaccia (`provider.ts`), un'implementazione
oggi (`anthropic.ts`, Claude via REST diretto, non l'SDK — coerente con Storage
e Mirakl). Aggiungerne un secondo domani è implementare l'interfaccia, non
riscrivere `draft.ts`.

**Tre cose non negoziabili in `generaBozza`, in quest'ordine:**
1. `message.interno = true` (le note fra operatori) non entra **mai** nel
   contesto — può contenere qualunque cosa un collega abbia scritto pensando
   restasse fra colleghi.
2. Ogni messaggio del cliente passa da `core/ai/redazione.ts` prima di finire
   nel prompt: IBAN, carte, codici fiscali oscurati — regola 8, qui non si
   tratta. Il pattern delle carte è scritto apposta per NON confondersi con un
   numero d'ordine Amazon (`407-6403985-4699551` ha la stessa forma
   cifre-trattini di un numero di carta letto alla leggera): c'è un test
   dedicato a questo.
3. Il testo che il modello propone non è la risposta: passa dallo stesso
   `core/policy.ts` di un invio vero prima di tornare all'agente, così una
   violazione si vede in anteprima e non al momento di premere Invia. Il
   risultato si salva in `ai_draft`, **mai spedito da questa funzione**.

**`ai_draft.fonti` (migrazione 0017, 28/08)**: le fonti della knowledge
base usate per la bozza si salvano sulla riga, non solo nella risposta
HTTP di `POST /threads/draft`. Serve a Lovable per mostrare di nuovo
l'ultima bozza già generata (testo, esito policy, fonti) quando si riapre
un thread, invece di dover rigenerare — e consumare credito AI — solo per
rivederla. `POST /threads/draft` resta l'unico modo di generarne una
*nuova*: leggere l'ultima esistente è una lettura diretta di Lovable su
`ai_draft` (già leggibile via RLS, vedi passo Dashboard), non passa dal
worker.

**Recupero dalla knowledge base**: per sovrapposizione fra `knowledge.tag` e
`thread.tags` — gli stessi tag che in Lovable fanno già da "intento
classificato" — ordinato per `priorita` (migrazione 0011) prima ancora che
per data: una procedura tipo "se il danno è segnalato, chiedi sempre le foto"
deve prevalere su una nota generica con lo stesso tag, non essere scartata
perché più vecchia. **DEBITO dichiarato**: nessuna ricerca
semantica/embeddings, solo overlap di tag. Funziona finché la knowledge base
resta piccola e ben taggata; un vero passo successivo se cresce.

**Tre modi di entrare nella knowledge base**, stesso schema per tutti e tre —
una "procedura" non è un tipo a parte, è una voce con i tag e la priorità
giusti:
- un documento (PDF o TXT, `POST /knowledge`, riservato al ruolo admin —
  passa dal worker perché serve estrarre il testo dal file, cosa che non ha
  senso far fare al browser);
- una voce scritta a mano dal pannello admin (`fonte = 'manuale'`, scrittura
  diretta da Lovable: dato interno, stessa categoria di tag/note — qui vive
  anche una procedura);
- una risposta di un operatore segnalata come buon esempio (`fonte =
  'esempio_operatore'`, scrittura diretta anch'essa).

Mai una `delete` su una voce: si disattiva (`attivo = false`) — potrebbe
essere già stata usata in una bozza passata.

**Link di riferimento** (`knowledge.url`, migrazione 0012): una voce può
puntare alla pagina di linee guida ufficiale di un marketplace (es. la
policy resi di Amazon). Il worker non la scarica mai — nessun fetch a
tempo di bozza — conta solo il testo scritto a mano in `contenuto`; il
link è incluso nel prompt come riferimento per il modello, con
un'istruzione esplicita a non incollarlo nella risposta a meno che non
serva davvero al cliente.

**Canali** (`knowledge.canali`, migrazione 0023, 28/08): la stessa
procedura può valere diversamente da un marketplace all'altro (le regole
di reso di Amazon non sono quelle di Mirakl). `text[]`, stesso principio
di `domini_esclusi` capovolto: qui NULL o vuoto è il caso comune e
significa "vale per tutti i canali", non richiede di spuntare nulla.

**Per operatore, non per kind (migrazione 0025, 29/08)**: inizialmente
`canali` conteneva il `kind` di `channel_account` ('shopify', 'mirakl',
...), ma Domenico ha segnalato che due operatori Mirakl diversi hanno
logiche di comunicazione diverse — una voce pensata per l'uno non deve
valere per l'altro solo perché condividono la piattaforma. Nessuna
modifica di schema: cambia solo cosa contiene la colonna, ora
`channel_account.code` (es. `mirakl-lmfr`), non più il `kind`.
`generaBozza()` filtra `and (canali is null or array_length(canali, 1)
is null or ${thread.account_code} = any(canali))` — la query seleziona
ora anche `ca.code as account_code`, non solo `ca.kind` (quello resta
per `verificaPolicy()`, che è correttamente per genere di canale, non
per operatore). Lato Lovable: il selettore nei tre form legge
dinamicamente gli operatori attivi da `channel_account` invece di una
lista fissa di kind, raggruppati per piattaforma; l'elenco mostra un
banner quando una voce ha un codice che non corrisponde più a un
operatore attivo (es. una voce salvata prima di questa migrazione con
un kind generico), da riaprire e correggere a mano.

**Esito della bozza** (`ai_draft.outcome`/`final_text`): `/threads/reply`
accetta ora un `draft_id` facoltativo. Se presente, dopo l'invio confronta
`draft_text` col testo davvero spedito (`core/ai/esito.ts`, uguaglianza
dopo trim) e scrive `outcome` (`usata_invariata` | `usata_modificata`) e
`final_text` sulla riga in `ai_draft`. Non fa mai fallire l'invio già
avvenuto: un problema qui finisce in un log, non in un errore all'agente.
Lato Lovable, l'editor deve ricordare l'id della bozza caricata con "Usa
questa bozza" e passarlo in `draft_id` all'invio — se l'agente scrive da
zero senza mai caricare una bozza, `draft_id` resta assente e quell'invio
non viene contato.

Lato Lovable, `draft_id` è collegato end-to-end (fatto): "Usa questa
bozza" lo porta fino all'invio.

### Dashboard di reportistica (migrazioni 0014, 0015)
`message.agent_id` e `message.draft_id` (0014) chiudono due lacune scoperte
costruendo la dashboard: prima, chi avesse spedito un messaggio si trovava
solo scavando in `audit_log` (fragile per una query che gira spesso), e da
un messaggio non si risaliva a quale bozza AI l'avesse originato. Sono
diretti sulla riga, non più solo nell'audit.

Quattro viste (0015), tutte `security_invoker = true` — **senza, una vista
gira con i permessi di chi l'ha creata e bypassa la RLS delle tabelle
sottostanti per chiunque la interroghi**, l'opposto di quello che serve:
- `v_thread_metriche` — una riga per thread: tempo alla prima risposta
  (`prima_risposta_at`/`minuti_prima_risposta`, dalla prima uscita non
  interna dopo `first_inbound_at`) e rispetto SLA (`entro_sla`, contro
  `channel_account.sla_minutes`).
- `v_tempi_risposta` — una riga per ogni messaggio in arrivo abbinato alla
  risposta successiva: il tempo di risposta "generale" (non solo la
  prima), con `agent_id` per le statistiche per operatore.
- `v_tag_giornalieri` — i tag di `thread.tags` srotolati un rigo per tag:
  la scomposizione per tipologia (RESO, DANNO, RECESSO, RIMBORSO,
  TRACKING...) è un conteggio su questa vista.
- `v_bozze_utilizzo` — bozze AI davvero spedite, con chi le ha spedite:
  `message.draft_id` incrociato con `ai_draft.outcome`.

**Non serve una vista** per ticket al giorno/per canale o per l'utilizzo AI
aggregato: select dirette su `thread`+`channel_account` annidato e su
`ai_draft`, stesso pattern già in uso in Lovable altrove.

**DEBITO noto**: `ai_draft` probabilmente non ha ancora una policy SELECT
per gli agenti autenticati — finora la bozza arrivava dalla risposta HTTP
del worker, mai da una lettura diretta. Se la dashboard la richiede e la
query torna vuota, è quello.

Prossimo passo: pannello Lovable che legge queste viste e mostra grafici
(ticket/giorno per canale, tempo di risposta medio, statistiche per
agente, utilizzo AI, ticket per tipologia).

### Canale "contatto" — ticket dai siti esterni (migrazione 0016)
I siti con l'agente AI nella pagina Contattaci (fatti in Lovable, brand
diversi dal marketplace principale) aprono un ticket qui invece di
mandare un'email formattata a mano — che avrebbe costretto
`ripulisci.ts`/`riconosci.ts` (pensati per email umane inoltrate da un
marketplace) a interpretare un caso che non è il loro.

`src/routes/contatti.ts` — `POST /contatti/:codice/ticket`. Un
`channel_account` per sito/brand, `kind = 'contatto'` — il codice non sa
quanti siti ci sono né come si chiamano, il brand di un ticket è sempre
quello nell'URL. **Un solo token per tutti i brand** (`CONTATTO_TOKEN`),
non uno per riga come Mirakl: qui non c'è un vero bisogno di isolamento
fra siti (stessa infrastruttura, stessa persona che li gestisce), e un
token per brand era solo un'occasione in più di sbagliare la
configurazione — deciso dopo il primo giro con più brand attivi insieme.
**Deve girare lato server** del sito chiamante, mai nel browser: un
token nel JavaScript di un sito pubblico sarebbe leggibile da chiunque.
Per questo niente CORS su questa rotta: non è pensata per essere
chiamata da una pagina.

Corpo: `email`, `nome` (facoltativo), `numero_ordine` (facoltativo,
confrontato contro `order.external_order_id`/`shopify_name`, con o senza
`#` iniziale — nessun ordine trovato non è un errore, il ticket si apre
comunque `unmatched`), `testo`, `richiesta_id` (facoltativo: se il
chiamante lo manda, un retry di rete con lo stesso valore non apre un
secondo ticket — regola 2, idempotenza).

Il messaggio si scrive con `raw.from = email`: `core/mail/invia.ts`
(usato per qualunque canale non-Mirakl) legge già quel campo per sapere a
chi rispondere, quindi la risposta dell'agente parte via email verso
l'indirizzo lasciato dal cliente senza nessuna modifica al connettore di
invio — stesso meccanismo di sempre, un canale in più che lo usa.

Come aggiungere un sito: la nota è scritta dentro la migrazione 0016.
