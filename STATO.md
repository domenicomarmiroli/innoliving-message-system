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
- **Allegati Mirakl in uscita**: meccanismo non deciso (multipart su M12,
  trovato verificando l'API pubblica, oppure documenti d'ordine via OR74,
  come scritto nel runbook originale — le due fonti non coincidono).
  `/threads/reply` risponde 422 esplicito su un allegato Mirakl, non tenta
  alla cieca.

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

**Resta da fare, lato Lovable:**
- Galleria/anteprima degli allegati in entrata (tab "Allegati" nel
  pannello contesto, oggi vuoto).
- Verificare un invio con allegato vero (serve prima la policy RLS sopra).
- Verificare un invio su un thread Mirakl (testo — gli allegati lì
  restano non supportati, per scelta).

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

## Prossimo passo del runbook

Classificazione dell'intento e bozze AI (passo 07). Serve la knowledge
base che Domenico deve fornire.

Vincolo da non dimenticare, già scritto in `CLAUDE.md` regola 8: IBAN,
carte e codici fiscali **non entrano mai** nel contesto del modello. Per
la garanzia con rimborso su IBAN il dato va chiesto fuori dalla
messaggistica del marketplace, e non deve essere visibile al centro
assistenza esterno.
