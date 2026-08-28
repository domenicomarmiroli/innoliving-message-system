# Dove siamo — 26 agosto 2026

Passaggio di consegne da una sessione Cowork a Claude Code.
`CLAUDE.md` spiega **come funziona** il sistema e perché; qui c'è solo
**cosa resta da fare** e cosa non è stato verificato.

---

## Fatto e funzionante

- **Shopify**: 5.407 ordini importati. Riconoscimento canale verificato su
  payload reali (mirakl 214/214 con `buyer_alias` — è la chiave che fa
  funzionare l'aggancio messaggio→ordine).
- **Casella Gmail** letta via IMAP ogni 60s, con filtro dei mittenti,
  pulizia del corpo, avvisi A-to-Z e riaggancio ritardato.
- **Mirakl**: connettore M11/M12 scritto, autenticazione verificata (200).
- **Interfaccia Lovable** su `fluent-desk-hub.lovable.app`, legge lo
  stesso database via RLS.

---

## Da fare subito

### 1. ✅ Push e deploy
Fatto il 26/08: `CLAUDE.md` + `STATO.md`, poi le sessioni successive,
tutto su `main`.

### 2. ✅ Webhook Shopify — **la causa degli ordini mancanti**
Registrati il 26/08 dalla Shell di Render:
```
ORDERS_CREATE        creato
ORDERS_UPDATED       creato
FULFILLMENTS_CREATE  creato
```
Nessun problema di scope — lo scope `write_webhooks` era già presente.

### 3. ✅ Mirakl — configurazione completata
`channel_account` per `mirakl-mms` verificato in Supabase: `endpoint`,
`deep_link` (confermato contro un URL vero — `/mmp/shop/order/{id}` era
corretto) e `secret_ref = 'MIRAKL_MMS_KEY'` tutti presenti. Variabile
d'ambiente impostata su Render direttamente in dashboard.
Resta il debito dichiarato più sotto: nessun cliente Mirakl ha ancora
scritto davvero, quindi il normalizzatore non è stato collaudato su
dati reali.

### 4. ✅ Migrazioni — verificate, tutte applicate (26/08)
```sql
select jsonb_pretty(value) from app_config where key = 'mail_ingest';
```
ha confermato `domini_esclusi` (19 voci), `domini_notifica`
(`amazon.com`), `domini_avviso` (`amazon.it`), `avviso_sla_minuti` (240),
`avviso_tag`, `giorni_coda` (7). 0001→0007 tutte a posto.

### 5. ✅ Pulizia dei dati sporchi — fatta, in forma ridotta
La query di ricognizione (`select ca.code, t.state, count(*)...`) ha
mostrato solo 3 thread di rumore sull'account casella (2 `amazon.com`,
1 `amazon.it` — notifiche/avvisi di piattaforma, non clienti): cancellati
con lo step 3 della 0003. Il resto (577 thread, tutti su `amazon-it`) è
risultato legittimo — 539 `closed` dallo step 4, 38 `unmatched` in attesa
del problema strutturale (ordini Amazon non ancora sincronizzati, vedi
sotto). **Non** è stato lanciato il `delete from thread` totale che
questo file proponeva come alternativa: i dati non erano residui da
buttare, solo rumore puntuale.

### 6. ✅ Pulizia dei corpi già importati — fatta (26/08)
```
messaggi esaminati: 1445
da riscrivere:      1437
già a posto:        8
```
Lanciata dalla Shell di Render dopo una prova a secco coerente. Riparte
da `raw`, quindi si può rifare quante volte serve se in futuro si scopre
un caso che il parser sbaglia.

---

## Interfaccia e allegati — sessione del 26/08 pomeriggio

Ripreso il lavoro con l'obiettivo di portare l'interfaccia Lovable a un
livello tipo Zendesk: editor risposte, allegati in/out, tag, assegnazione,
gestione utenti. Trovati e letti i documenti di analisi originali (panoramica,
runbook L0-L10/C1-C20, mockup pannello ordine) e ispezionato il progetto
Lovable vero via MCP — non solo il runbook, il codice reale.

**Stato reale di Lovable trovato**: L0 (design system) e buona parte di L2
(coda, pannello contesto, conversazione) già fatti e funzionanti, letti da
Supabase. `reply-editor.tsx` esiste ma è solo un guscio visivo — nessuna
mutazione da nessuna parte in `hub-data.ts`: niente invio, niente tag, niente
assegnazione. Gestione utenti implementata da Domenico nel frattempo.

**Fatto qui (worker), tutto deployato e verificato senza errori nei log:**

1. **Autenticazione sicura per l'invio.** `/threads/reply` non richiede più
   solo `WORKER_API_TOKEN`: accetta anche `Authorization: Bearer <sessione
   Supabase>`, verificata chiedendo a Supabase Auth di chi è il token
   (`core/agente.ts`) — niente segreto statico nel bundle di Lovable, che
   sarebbe stato estraibile dagli strumenti sviluppatore. `SUPABASE_URL` e
   `SUPABASE_ANON_KEY` (valori pubblici, presi da `src/lib/supabase.ts` di
   Lovable) impostati su Render.
2. **Policy guard** (`core/policy.ts`): niente URL/email/telefono/richieste
   di recensione/inviti a contattare fuori piattaforma su Amazon (5 lingue),
   niente contatti diretti su Mirakl. 422 con la porzione di testo
   incriminata.
3. **Allegati in entrata**, byte veri non solo metadati: casella email
   (`core/storage.ts` + `upsert.ts`) e Mirakl via M13 (`client.ts.download()`
   + `upsert.ts`). Migrazione 0008 (bucket privato `allegati` + colonne
   `larghezza`/`altezza`) applicata. `SUPABASE_SERVICE_ROLE_KEY` impostata su
   Render.
4. **Allegati in uscita** (`core/attachments/normalize.ts`): su Amazon
   converte JPG→PNG automaticamente (mai rifiuta — è il formato delle foto
   da telefono) e ricomprime sopra i 6 MB. Testato sui due criteri esatti del
   runbook: JPG 9+ MB → PNG sotto 5 MB, zip rifiutato con motivo leggibile.
   `/threads/reply` accetta `allegati: [{storage_path, nome_file, mime}]` —
   riferimenti a file caricati da Lovable direttamente su Storage.

**Debiti nuovi, dichiarati in CLAUDE.md:**
- **HEIC/HEIF** (foto iPhone): sharp non lo legge in modo affidabile senza
  una libreria dedicata. Oggi un HEIC in entrata si carica senza dimensioni
  né conversione; in uscita viene rifiutato con un motivo esplicito, non
  convertito.

**✅ Risolto: allegati Mirakl in uscita (26/08 sera).** Il conflitto fra le
due fonti (multipart M12 vs documenti d'ordine OR74) risolto leggendo la
documentazione pubblica di entrambi gli endpoint, non fidandosi del runbook
originale: OR74 è a livello di ordine, non di thread — non è la strada
giusta. M12 accetta `multipart/form-data` con `message_input.body` +
`files[]`, pensato esattamente per allegare file a una risposta. Implementato
in `client.ts` (`postMultipart`) e `invia.ts`; `/threads/reply` non rifiuta
più con 422 gli allegati su Mirakl. Resta il debito di sempre su questo
connettore: verificato sulla documentazione, non ancora su un invio reale —
nessun cliente Mirakl ha ancora scritto.

**Fatto anche lato Lovable, tre prompt inviati ed eseguiti:**
5. Invio risposta collegato a `/threads/reply` con sessione Supabase,
   violazioni 422 mostrate in modo specifico, ⌘/Ctrl+Invio funzionante.
6. Tag (con il tag "intento" segnalato), assegnazione ("Assegna a me"
   incluso) e cambio stato — scrittura diretta su Supabase, non tramite
   il worker: sono dati puramente interni.
7. Allegati in uscita: pulsante "Allega" collegato, upload diretto su
   Storage sotto `interfaccia/{agent_id}/...`, incluso nel corpo
   dell'invio. Policy RLS fornite da Lovable, da eseguire a mano:
   ```sql
   create policy "Agenti caricano in interfaccia"
   on storage.objects for insert to authenticated
   with check (bucket_id = 'allegati' and (storage.foldername(name))[1] = 'interfaccia');
   create policy "Agenti leggono allegati"
   on storage.objects for select to authenticated
   using (bucket_id = 'allegati');
   ```

**Bug trovato e corretto nello stesso giro: CORS mancante.** Il worker non
aveva mai `@fastify/cors` registrato — il browser di Lovable bloccava la
richiesta prima ancora che arrivasse al server, con un errore di rete
generico invece di un 401. Aggiunta `INTERFACCIA_ORIGINS` (elenco esplicito,
mai un jolly) e impostata su Render.

**✅ VERIFICATO END-TO-END SU UN CLIENTE VERO (26/08, 17:17).** Risposta
inviata da Lovable su un thread Amazon reale (Biagio, ordine
407-6403985-4699551): log del worker (`risposta inviata`) → email in
Gmail Inviati, destinatario il relay corretto → **comparsa nel thread
giusto su Amazon Seller Central**, in ordine cronologico, sotto lo stesso
scambio — conferma che anche il threading (In-Reply-To/References) regge.
Prima verifica reale, non solo test automatici, dell'intera catena di
invio ricostruita oggi.

**Fatto anche: galleria/anteprima allegati (quarto prompt Lovable).**
`attachmentsQuery` in un solo giro, miniature vere per le immagini (URL
firmati, bucket privato) sotto ogni messaggio e nella scheda "Allegati";
icona generica per ciò che non ha un file (upload fallito, o HEIC).

**✅ VERIFICATO END-TO-END ANCHE CON ALLEGATO, SU UN CLIENTE VERO (26/08,
17:47).** Primo tentativo fallito con **502**, causa trovata nei log e
risolta in due passaggi:
1. Il nome del file (uno screenshot, tipicamente pieno di spazi:
   `Screenshot 2026-08-26 173753.png`) non veniva codificato nell'URL
   verso Supabase Storage — 400 su ogni file con uno spazio nel nome,
   il caso comune, non l'eccezione. `codificaPercorso()` in
   `core/storage.ts`, con test di regressione.
2. Il 400 persisteva ANCHE dopo quel fix: mancava l'header `apikey`
   accanto ad `Authorization` — Supabase lo richiede sempre insieme per
   identificare il progetto. Aggiunto su upload e download, con test
   che verifica la presenza di entrambi gli header.
Poi trovato un terzo dettaglio più piccolo: dopo l'invio l'interfaccia
invalidava `["message", thread.id]` e `["threads"]` ma non
`["attachment", thread.id]` (aggiunta dopo, in un prompt successivo) —
l'allegato spedito non compariva finché non si riapriva il thread.
Corretto con un quinto prompt Lovable, una riga.
Dopo questi tre fix: risposta con screenshot allegato inviata su un
thread Amazon reale, confermata su Gmail Inviati ("One attachment").

**Resta da fare, lato Lovable:**
- Verificare un invio su un thread Mirakl (testo — gli allegati lì
  restano non supportati, per scelta).

---

## Bozze AI e knowledge base — sessione del 26/08 sera

Deciso con Domenico: niente Lovable Cloud (vietato per architettura — il
database è un Supabase esterno, l'interfaccia non deve mai chiamare API
esterne dal browser). Le bozze si generano nel worker, provider Claude
dietro un'interfaccia intercambiabile.

**Costruito e deployato**: `POST /threads/draft` (redazione IBAN/carte/
codici fiscali prima del prompt, note interne mai incluse, il testo
proposto passa dallo stesso policy guard di un invio vero), `POST
/knowledge` (documento PDF/TXT, solo ruolo admin, estrazione testo con
pdf-parse), migrazione 0010 (tabella `knowledge`, recupero per
sovrapposizione di tag col thread — non ricerca semantica, debito
dichiarato). 116 test verdi.

**Lato Lovable**: scheda "Bozza AI" nel pannello contesto collegata
(genera, mostra fonti ed eventuali violazioni di policy, "Usa questa
bozza" versa il testo nell'editor senza inviarlo mai da sola).

**Due bug trovati nel primo giro di test, entrambi corretti:**
1. CORS: Lovable ha DUE origini diverse da autorizzare, non una —
   `*.lovable.app` (pubblicato/anteprima) e `*.lovableproject.com`
   (l'iframe di anteprima dentro l'editor stesso, dominio del tutto
   diverso). Mancava la seconda: `INTERFACCIA_ORIGINS` aggiornata su
   Render.
2. **Non un bug**: un vecchio pulsante decorativo "Bozza AI" (icona
   Sparkles) nella barra dell'editor di risposta, mai collegato a
   nulla fin da L0, causava confusione — l'utente lo cliccava pensando
   fosse la funzione vera. Rimosso.

**✅ VERIFICATO: prima bozza AI generata su un thread reale (26/08
sera)**, Claude Sonnet 5, testo coerente col contesto (reso/garanzia)
del thread. Nessuna fonte knowledge base (base ancora vuota, nessun
documento caricato) — atteso.

**✅ Migrazione 0011 applicata (26/08 sera)**: colonna `knowledge.priorita`
(verificata: `integer`, default `0`) e fonte `'manuale'` ammessa dal
vincolo — una voce scritta a mano dal pannello admin, senza passare da un
file. Il recupero in `draft.ts` ordina ora `priorita desc, created_at desc`.

**✅ Pannello admin knowledge base — costruito (26/08 sera).** Pagina
`/conoscenza` in Lovable: elenco con filtri fonte/tag e ordine per
priorità, caricamento documento (upload su Storage → `POST /knowledge`
sul worker per l'estrazione testo), inserimento manuale, modifica,
disattivazione (mai `delete`). Azione "Segnala come buon esempio" su ogni
risposta inviata in conversazione (`fonte = 'esempio_operatore'`),
disponibile a qualunque agente, non solo admin.

Policy RLS fornite da Lovable ed **eseguite da Domenico** nell'editor SQL
di Supabase: funzioni `public.e_admin()` / `public.e_agente()` (security
definer, su `agent.user_id`/`ruolo`/`active`), policy select/insert/update
su `knowledge` e insert su `storage.objects` per il prefisso `knowledge/`
nel bucket `allegati`.

**✅ Verifica funzionale — inserimento manuale confermato (26/08 sera).**
Domenico ha creato una voce dal pannello e ho controllato la riga in
Supabase: `fonte = 'manuale'`, tag corretti, `attivo = true`, `creato_da`
valorizzato. Le policy RLS funzionano end-to-end. **Resta da verificare**:
caricamento PDF e "segnala come buon esempio" — non urgenti, si vedono
al primo uso reale.

**✅ Link di riferimento (`knowledge.url`, migrazione 0012, 26/08 sera).**
Una voce manuale può ora portare un link alle linee guida ufficiali di un
marketplace (es. la pagina resi di Amazon) accanto al testo scritto a
mano: il worker non lo scarica mai, è solo un riferimento passato al
modello con l'istruzione di non incollarlo nella risposta. Campo aggiunto
al form di inserimento/modifica e all'elenco (link cliccabile) in Lovable.

**✅ Esito bozza AI (`ai_draft.outcome`/`final_text`, 27/08).**
`/threads/reply` accetta un `draft_id` facoltativo e, se presente,
confronta il testo spedito con `draft_text` (`core/ai/esito.ts`) scrivendo
`usata_invariata` o `usata_modificata`. È il pezzo di "verifica su casi
reali" che CLAUDE.md segnava come prossimo passo.

Lato Lovable, `draft_id` è collegato end-to-end: "Usa questa bozza" passa
`draft.id` insieme al testo, uno stato `pendingDraftId`/`activeDraftId`
lo tiene fino all'invio e lo resetta su invio riuscito, editor svuotato,
cambio thread o scelta di un template. **Resta solo da accumulare dati
reali** e leggere `ai_draft.outcome` per capire quanto le bozze vengono
usate così come sono.

---

## Debiti dichiarati

**Mirakl è scritto sulla documentazione, non su risposte vere.** Quando è
stato costruito nessun cliente aveva ancora scritto e l'API restituiva
`{"data":[]}`. Il normalizzatore è tollerante e registra ogni scostamento
in `ingest_anomaly` con tipo `mirakl_*`. Al primo messaggio vero:

```bash
npm run mirakl:check -- --forma
```

Il punto più incerto è `from.type`, da cui dipende se un messaggio è del
cliente o nostro.

**Le fixture email sono quasi tutte sintetiche.** Solo
`amazon-messaggio-reale.eml` ha il corpo vero. Vedi i LEGGIMI in
`test/fixtures/`.

**Il `deep_link` Mirakl** è inventato (vedi punto 3).

**✅ Bug corretto (27/08): falso positivo "telefono" su un numero
d'ordine Amazon.** Una bozza AI citava il numero d'ordine del cliente
(`405-0668977-2033157`) per chiedere conferma, e `core/policy.ts` la
bloccava scambiandolo per un contatto — stessa forma superficiale del
formato ordine, stesso problema già risolto per la redazione IBAN/carte.
Corretto con la stessa distinzione, test di regressione aggiunto.

---

## Cose che nessuno ha ancora fatto e vanno fatte

**✅ Ruotata la password del database Supabase** (26/08, fatta da Domenico
direttamente in Supabase e Render — non verificata riga per riga da qui
per non maneggiare il segreto, ma confermata indirettamente: i log di
Render non mostrano nessun `CONNECT_TIMEOUT` né errore di autenticazione
dopo le 13:00 del 26/08, e l'ultimo deploy è `live`).

**✅ Dati dimostrativi — verificato, non ce n'erano** (26/08): sia
`ordini_demo` che `thread_demo` sono risultati **0**. Nessuna `delete`
eseguita, non serviva.

---

## Il problema strutturale aperto

**Gli ordini Amazon non entrano in Shopify.** Misurato: su 1.438 messaggi
in arrivo, 1.406 citano un numero d'ordine leggibile e **zero** di quegli
ordini erano in archivio.

Il connettore casella funziona; manca l'altra metà del dato. Domenico ha
detto che attiverà la sincronizzazione a breve. Quando succederà,
`riaggancia.ts` aggancerà da solo le conversazioni in attesa al primo
giro di polling — non serve lanciare niente.

Se invece la sincronizzazione non arrivasse, l'alternativa è prendere gli
ordini Amazon da SP-API o da un report di Seller Central. È un pezzo
previsto nel runbook e mai costruito.

---

## Dashboard di reportistica — sessione del 27/08

Richiesta da Domenico: ticket/giorno per canale, tempo di risposta medio,
statistiche per agente, utilizzo AI, ticket per tipologia, rispetto SLA.

**Fatto lato worker**: `message.agent_id`/`message.draft_id` (migrazione
0014, chi ha spedito e da quale bozza), quattro viste `security_invoker =
true` (migrazione 0015): `v_thread_metriche` (tempo alla prima risposta,
`entro_sla`), `v_tempi_risposta` (tempo di risposta generale per agente),
`v_tag_giornalieri` (tag srotolati per tipologia), `v_bozze_utilizzo`
(bozze spedite per agente, invariate/modificate). 125 test verdi.

**Fatto lato Lovable**: pagina `/report` (solo admin) — filtro date con
periodi rapidi, granularità giorno/settimana/mese, KPI (nuovi ticket,
prima risposta, risposta generale, % SLA), grafico "Ticket nel tempo",
ripartizione per canale e per tipologia, tabella per agente, riquadro
utilizzo AI. Policy RLS su `ai_draft` fornita da Lovable ed eseguita da
Domenico (mai letto direttamente prima: la bozza arrivava dalla risposta
HTTP del worker).

**Bug trovato e corretto nello stesso giro**: "Nuovi ticket" contava
`thread.created_at` (quando la riga entra nel database) invece di
`thread.first_inbound_at` (quando il cliente scrive davvero) — per
l'importazione storica di tre mesi di posta le due date sono lontanissime,
e il grafico mostrava un picco finto di 583 ticket tutti sul giorno
dell'import. Corretto: il grafico ora ha tre serie per ticket distinto
(non messaggio grezzo) — Nuovi ticket, Conversazioni (rinominata da
Domenico da "Hanno scritto"), Risposto.

**✅ VERIFICATO da Domenico**: dopo il fix il totale passa correttamente
da 583 a un numero più basso nella finestra di 30 giorni selezionata,
perché la maggior parte dello storico importato ha una data reale più
vecchia della finestra — comportamento atteso, non un bug.

---

## Leroy Merlin France (Mirakl) attivato — 27/08

Domenico ha fornito la chiave API reale (`MIRAKL_LMFR_KEY`, endpoint
`adeo-marketplace.mirakl.net`). `channel_account.code = 'mirakl-lmfr'`
completato (endpoint + secret_ref) e chiave impostata su Render.

**✅ VERIFICATO SU DATI VERI**: primo giro dopo il riavvio ha inserito
**1.558 messaggi** reali, zero errori. È il primo cliente Mirakl reale che
scrive in questo sistema dal giorno in cui il connettore è stato
costruito — collauda di fatto il debito dichiarato in CLAUDE.md
("scritto sulla documentazione, non su risposte vere").
**505 ordini Leroy Merlin già presenti** in `order` (arrivano da
Shopify): non è il problema strutturale di Amazon, l'aggancio funziona
per gli ordini già sincronizzati; i thread ancora "non in archivio" si
risolvono da soli quando arriva anche il resto.

**⚠️ INCIDENTE, causato da questo stesso import — risolto in giornata.**
L'afflusso improvviso (1.587 thread totali, raddoppiati da 583 a un
tratto) ha rotto la coda principale di Lovable: "Nessun ticket in questa
vista", zero errori a schermo. Due giri di fix:
1. Diagnosi e primo fix: la query della coda non era paginata e
   incorporava messaggi/allegati/righe ordine per ogni thread — troppo
   pesante col volume raddoppiato. Aggiunta paginazione (200 per pagina)
   e separazione fra dati leggeri della lista e dettaglio completo del
   thread aperto.
2. Il primo fix ha introdotto un bug nuovo, trovato con una seconda
   indagine più rigorosa (git diff sulla cronologia, non supposizioni):
   il limite di 200 righe veniva applicato **prima** del filtro che
   esclude i thread chiusi, non dopo. Ordinati per scadenza, i primi 200
   erano per caso tutti `closed` (verosimile con centinaia di thread
   storici), il filtro lato client li eliminava tutti e la lista restava
   vuota. Corretto spostando il filtro di stato nella query lato server,
   prima del limite.

**Lezione per il prossimo operatore Mirakl (o qualunque import massiccio
futuro)**: un afflusso improvviso di migliaia di righe è un test di
carico non pianificato per l'interfaccia. Verificare la coda subito dopo
un import grosso, non solo il worker.

**✅ Tre bug del connettore Mirakl trovati e corretti collaudando su
questo primo cliente reale** (dettagli in CLAUDE.md): `from.type` ha tre
valori veri (noi/cliente/marketplace, non solo noi/cliente — il
marketplace scrive notifiche automatiche tipo richieste di fattura); M12
non accetta JSON, solo multipart, e il ramo JSON del connettore non
avrebbe mai funzionato; `message_input.to` è obbligatorio e mancava del
tutto — ogni invio reale sarebbe stato rifiutato. Tutti e tre corretti
prima che un cliente Mirakl ricevesse una risposta rotta.

**Resta da fare, lato Lovable**: selettore destinatario ("Cliente" /
"Operatore" / "Entrambi") nell'editor di risposta, visibile solo per i
thread Mirakl — il worker accetta già `mirakl_destinatari` in
`/threads/reply`.

---

## Vista Resi, dettaglio reso indipendente dal tracking, ordine dei
## Chiusi — 28/08

Domenico ha chiesto tre cose dopo aver visto la sezione "Reso" in azione:
1. una vista dedicata coi soli ticket con reso aperto;
2. vedere che un reso è stato aperto anche PRIMA che Amazon emetta
   l'etichetta (oggi la sezione "Reso" spariva del tutto se
   corriere/tracking erano vuoti);
3. la vista "Chiusi" ordinata per ultima chiusura, non per scadenza SLA
   (che per un ticket già chiuso non serve più).

**Fatto lato worker** (migrazione 0020): `order.reso_richiesto_at`
(sempre valorizzata da `registraReso()`, indipendente da corriere/
tracking — è sull'ordine, quindi visibile su qualunque ticket collegato,
non solo quello con l'email) e `thread.closed_at` (scritta da un trigger
al passaggio a `closed`, azzerata alla riapertura — non lasciata a
Lovable, così resta corretta da qualunque punto dell'interfaccia si
cambi lo stato).

**Fatto lato Lovable, stesso giro**: quinta vista "Resi" nella barra
(tag `reso-richiesto`, esclusi i chiusi, scorciatoia `g r`); sezione
"Reso" ora appare su `reso_richiesto_at` invece che su corriere/tracking,
mostrando sempre la data della richiesta e, se presenti, corriere e
tracking; vista "Chiusi" ordinata per `closed_at` discendente.

**Da eseguire in Supabase**:
```sql
alter table "order" add column if not exists reso_richiesto_at timestamptz;
alter table thread add column if not exists closed_at timestamptz;

create or replace function public.thread_set_closed_at()
returns trigger language plpgsql as $$
begin
  if new.state = 'closed' and (old.state is distinct from 'closed') then
    new.closed_at := now();
  elsif new.state <> 'closed' and old.state = 'closed' then
    new.closed_at := null;
  end if;
  return new;
end;
$$;

drop trigger if exists thread_closed_at_trg on thread;
create trigger thread_closed_at_trg
  before update on thread
  for each row execute function public.thread_set_closed_at();

update thread set closed_at = updated_at
where state = 'closed' and closed_at is null;
```
**Da verificare**: che la vista "Resi" e il nuovo ordinamento dei Chiusi
funzionino su dati reali dopo che Domenico esegue la migrazione.

---

## Rimborsi emessi Amazon — sessione del 28/08

Domenico ha fornito un'email reale di conferma rimborso ("rimborso
169.01 EUR avviato - ordine 405-8567267-4113132",
`X-Space-Notification-Type: REFUND_ISSUED`) e ha chiesto lo stesso
trattamento dei resi: memorizzare data e dettagli del rimborso
sull'ordine, e una vista dedicata.

**Differenza importante trovata leggendo l'esemplare**: un rimborso può
ripetersi (rimborsi parziali su articoli diversi, email diverse nel
tempo) — a differenza di un reso, che è un evento singolo per ordine. Il
meccanismo "già visto" per tag usato da resi/avvisi qui avrebbe scartato
un secondo rimborso vero. `rimborsi.ts` usa invece il vincolo unique su
`rfc822_id` come unica difesa contro il duplicato: solo se l'insert del
messaggio inserisce davvero una riga nuova si somma l'importo
sull'ordine.

**Fatto lato worker** (migrazione 0021): `order.rimborso_totale`
(somma cumulativa) e `order.rimborso_emesso_at` (data ultimo rimborso),
tag `rimborso-emesso` sul thread. Estrazione condivisa con `resi.ts`
tramite il nuovo `src/connectors/mail/html.ts` (stessa impaginazione a
lista + tabella). 152 test verdi, tra cui uno sull'email reale.

**Fatto lato Lovable, stesso giro**: vista "Rimborsi" nella barra
(scorciatoia `g b`), sezione "Rimborso" nel pannello di contesto (totale
rimborsato, data ultimo rimborso), separata dalla sezione "Reso" — sono
due informazioni diverse (richiesta del cliente vs rimborso emesso).

**Da eseguire in Supabase**:
```sql
alter table "order"
  add column if not exists rimborso_totale     numeric(12,2),
  add column if not exists rimborso_emesso_at  timestamptz;
```
**Da verificare**: la vista "Rimborsi" e la sezione dedicata su dati
reali dopo che Domenico esegue la migrazione.

---

## Resi e rimborsi nel report — 28/08

Domenico ha chiesto di aggiungere resi e rimborsi alla dashboard: numero
di richieste di reso nel grafico giornaliero; per i rimborsi, numero E
valore.

**Trovato subito**: la vista `v_tag_giornalieri` (migrazione 0015),
pensata per la ripartizione per tipologia, non andava bene qui — è
datata su `thread.created_at` (quando il thread è nato, non quando
l'evento è successo) e un tag non conta le occorrenze ripetute (un
ordine può avere più rimborsi parziali nel tempo, stesso thread, stesso
tag "rimborso-emesso" una volta sola). Serviva il livello del singolo
messaggio-evento con la sua data vera.

**Fatto lato worker** (migrazione 0022): `message.tipo_evento`
('reso_richiesto' | 'rimborso_emesso', null per i messaggi normali) —
serve a isolare questi eventi dagli altri messaggi di sistema (avvisi,
notifiche) che hanno la stessa forma ma nessun modo di distinguersi
prima d'ora. `message.importo`/`message.importo_valuta`: l'importo DI
QUEL rimborso specifico, non cumulativo — la dashboard soma per
periodo. 152 test verdi.

**Fatto lato Lovable, stesso giro**: due KPI ("Richieste di reso",
"Rimborsi emessi" con totale), grafico "Richieste di reso nel tempo"
(barre) e "Rimborsi nel tempo" (barre + linea del valore su asse
destro) — select dirette su `message`, stesso periodo/granularità del
resto della pagina. **Dettaglio gestito bene dall'agente senza che
glielo chiedessi**: i totali si raggruppano per `importo_valuta` invece
di assumere sempre EUR — valute diverse non si sommano fra loro, e se ne
compare più di una lo segnala sotto il grafico.

**Da eseguire in Supabase**:
```sql
alter table message
  add column if not exists tipo_evento     text,
  add column if not exists importo         numeric(12,2),
  add column if not exists importo_valuta  text;

create index if not exists message_tipo_evento_idx
  on message (tipo_evento, sent_at) where tipo_evento is not null;
```
**Da verificare**: i due grafici su dati reali dopo la migrazione — oggi
in produzione c'è già almeno un reso e un rimborso reali da mostrare.

---

## Messaggi Mirakl in HTML mostravano i tag grezzi — 28/08

Domenico ha segnalato una bolla con `<b>`, `<ul>`, `<a>` visibili così
come sono su una notifica di sistema Leroy Merlin/Adeo ("richiesta di
fattura"). Causa: Mirakl manda `body` in HTML per i messaggi di sistema,
ma finiva tutto in `message.body_text`, mostrato come testo semplice.

**Fatto lato worker** (nessuna migrazione, solo codice — `body_html`
esisteva già in schema): `normalize.ts` rileva quando il corpo Mirakl
contiene un tag HTML vero e lo separa — testo pulito in `body_text`,
markup originale in `body_html`. `core/html.ts` spostato da
`connectors/mail/` a `core/`, ora condiviso anche dal connettore Mirakl.
154 test verdi, incluso uno sul testo reale fornito da Domenico.

**Fatto lato Lovable, stesso giro**: la bolla mostra `body_html`
sanificato (DOMPurify, lista tag ristretta, link solo http/https con
target="_blank" e rel="noopener noreferrer") al posto di `body_text`
SOLO per i thread Mirakl — email e Shopify non cambiano.

Nessuna azione richiesta in Supabase: solo codice, `body_html` era già
una colonna esistente.

---

## Bug Mirakl: primo invio reale falliva con 502 — 28/08

Domenico ha testato il primo invio di una risposta su un thread Leroy
Merlin (Mirakl) e ha visto "Invio non riuscito (errore 502)". Log di
Render: `mirakl-lmfr: richiesta fallita (400): {"errors":[{"code":
"message_input","message":"Required part 'message_input' is not
present."}]}`.

Causa: `invia.ts` mandava i campi del messaggio appiattiti
(`message_input.body`, `message_input.to[0].type`) invece di un'unica
parte multipart chiamata esattamente `message_input` col JSON intero —
la forma che Mirakl documenta davvero
(`-F "message_input=@message_input.json;type=application/json"`). I tre
bug del connettore trovati il 27/08 erano tutti sulla LETTURA dei
messaggi; questo è il primo collaudo reale della SCRITTURA, e ha trovato
un problema diverso.

Corretto (`costruisciMessageInput()` in `invia.ts`, con test di
regressione). 144 test verdi, typecheck e build ok.

**✅ VERIFICATO END-TO-END (28/08, 11:52).** Log worker: `risposta Mirakl
inviata`, `operatore: mirakl-lmfr`, `200`. Confermato anche visivamente sul
portale Leroy Merlin: il messaggio compare nel thread giusto, indirizzato a
"Operator" e marcato "Invisibile al cliente" — conferma che anche la
scelta del destinatario (`mirakl_destinatari`, il selettore
Cliente/Operatore) funziona, non solo l'invio di default al cliente. Primo
invio Mirakl riuscito su questo sistema.

**Lacuna trovata dallo stesso test**: Domenico aveva scelto
"Cliente e Operatore" ma dalla nostra cronologia non si vedeva a chi fosse
andato davvero il messaggio — dato solo nella richiesta, mai salvato.
Aggiunta `message.mirakl_destinatari` (migrazione 0019) e, lato Lovable,
un'etichetta "A: Cliente" / "A: Operatore" / "A: Cliente e Operatore" sotto
ogni bolla in uscita che la valorizza. **Da eseguire in Supabase**:
```sql
alter table message add column if not exists mirakl_destinatari text[];
```

---

## Richieste di reso Amazon — sessione del 28/08

Domenico ha segnalato che le richieste di reso autorizzate da Amazon (email
"Notifica di autorizzazione del reso") non venivano lette: il cliente apre
un reso, e nessuno se ne accorge finché non scrive di nuovo. Fornito un
esemplare reale (ordine 403-1049451-9270721,
`test/fixtures/mail/amazon-richiesta-reso-reale.eml`), rispettando la
regola 6 di CLAUDE.md — nessun parser costruito sulla sola descrizione o
sullo screenshot.

**Scoperta che ha semplificato il progetto iniziale**: l'ipotesi di partenza
era che la notifica di reso e l'etichetta di spedizione (corriere +
tracking) arrivassero in due email separate. Il file reale mostra che sono
la STESSA email: un solo riconoscitore, un solo parser, nessuna
correlazione fra email diverse da gestire.

**Fatto**:
- Header `X-Space-Notification-Type: RETURN_REQUEST` come segnale di
  riconoscimento (`parse.ts`, `tipi.ts`) — più affidabile del dominio, che
  Amazon condivide fra più tipi di notifica (`amazon.com`).
- Nuovo genere `'reso'` in `classificaMittente()` (`riconosci.ts`), inserito
  PRIMA delle liste per dominio: senza, una richiesta di reso verrebbe
  scambiata per una notifica di mancata consegna (stesso dominio
  `amazon.com`) e riaprirebbe il thread con il messaggio sbagliato.
- `src/connectors/mail/resi.ts` (nuovo): `estraiDatiReso()` legge dalla
  tabella HTML (articolo/ASIN/SKU/quantità/motivo/commento) e dai campi
  riassuntivi (data richiesta, verifica politiche, autorizzazione, corriere
  e tracking del reso); `registraReso()` — stesso schema di
  `registraAvviso()` — annota la conversazione dell'ordine esistente (non
  ne crea una parallela), tag `reso-richiesto`.
- Migrazione 0018: `order.reso_carrier` / `order.reso_tracking_number`,
  distinte da `carrier`/`tracking_number` (che tracciano la spedizione IN
  USCITA verso il cliente, non quella di rientro).
- `imap.ts` — nuovo ramo nel ciclo di lettura, contatore `resi` in
  `EsitoCiclo`.
- Test sull'esemplare reale (`test/mail-resi.test.ts`,
  `test/mail-riconosci.test.ts`): estrazione dei campi, formattazione del
  riassunto, e la precedenza reso/notifica sullo stesso dominio. 149 test
  verdi.

**Da eseguire in Supabase** (fornita a Domenico):
```sql
alter table "order"
  add column if not exists reso_carrier          text,
  add column if not exists reso_tracking_number   text;
```

**✅ Fatto lato Lovable (28/08, stesso giorno)**: sezione "Reso" nel
pannello di contesto, separata dalla spedizione in uscita, visibile solo
quando `reso_carrier`/`reso_tracking_number` sono valorizzati. Il tag
`reso-richiesto` non era filtrato da nessuna whitelist, compare già dove
compaiono gli altri tag.

**Dettaglio da annotare**: il tracking di reso è cliccabile solo se
`channel_account.config` ha una chiave `return_tracking_url` (o
`reso_tracking_url`) con segnaposto `{tracking_number}` — decisione
dell'agente Lovable, coerente col principio "i modelli di URL verso i
corrieri arrivano dalla configurazione del canale", non dettata da me.
Senza quella chiave il numero resta visibile come testo, non come link.
**Limite non risolto**: un solo modello di URL per canale non distingue
fra corrieri diversi (es. POSTE_ITALIANE vs altri) se un giorno servisse
— per ora non è un problema, un solo esemplare reale visto finora.

---

## Prossimo passo del runbook

Classificazione dell'intento e bozze AI (passo 07). Serve la knowledge
base che Domenico deve fornire.

Vincolo da non dimenticare, già scritto in `CLAUDE.md` regola 8: IBAN,
carte e codici fiscali **non entrano mai** nel contesto del modello. Per
la garanzia con rimborso su IBAN il dato va chiesto fuori dalla
messaggistica del marketplace, e non deve essere visibile al centro
assistenza esterno.
