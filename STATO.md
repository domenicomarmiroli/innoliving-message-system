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

## Prossimo passo del runbook

Classificazione dell'intento e bozze AI (passo 07). Serve la knowledge
base che Domenico deve fornire.

Vincolo da non dimenticare, già scritto in `CLAUDE.md` regola 8: IBAN,
carte e codici fiscali **non entrano mai** nel contesto del modello. Per
la garanzia con rimborso su IBAN il dato va chiesto fuori dalla
messaggistica del marketplace, e non deve essere visibile al centro
assistenza esterno.
