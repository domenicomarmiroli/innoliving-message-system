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

### 6. Pulizia dei corpi già importati — ancora da fare
```bash
npm run mail:ripulisci -- --prova     # mostra cosa cambierebbe
npm run mail:ripulisci                # riscrive
```
Riparte da `raw`, quindi si può rifare quante volte serve.

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

**Ruotare la password del database Supabase.** È stata scritta in chiaro
in una conversazione. Usare solo caratteri alfanumerici: i simboli nella
connection string vanno codificati e generano errori difficili da
diagnosticare. Poi aggiornare `SUPABASE_DB_URL` su Render.

**Cancellare i dati dimostrativi**, se ancora presenti:
```sql
delete from thread where 'demo' = any(tags);
delete from "order" where raw->>'demo' = 'true';
```

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
