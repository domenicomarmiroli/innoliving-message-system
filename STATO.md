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

### 1. Push e deploy
L'ultimo lavoro (registrazione webhook Shopify + allineamento periodico)
è committato ma potrebbe non essere ancora su GitHub. Render deploya da
`main`: senza push, i comandi nuovi non esistono sul server.

### 2. Webhook Shopify — **la causa degli ordini mancanti**
Non sono mai stati registrati. È per questo che gli ordini recenti non
comparivano nel database.

```bash
npm run shopify:webhooks -- https://hub-messaggi-worker.onrender.com
```

Se risponde 403, all'app manca lo scope `write_webhooks`: aggiungerlo nel
Dev Dashboard, fare una release, reinstallare.

### 3. Mirakl — completare la configurazione
- Variabile `MIRAKL_MMS_KEY` su Render (chiave dal back office Mirakl:
  proprio nome in alto a destra → Le mie impostazioni → API key)
- E in Supabase:

```sql
update channel_account
set config     = config || jsonb_build_object(
                   'endpoint',  'https://mediamarktsaturn.mirakl.net',
                   'deep_link', 'https://mediamarktsaturn.mirakl.net/mmp/shop/order/{id}'
                 ),
    secret_ref = 'MIRAKL_MMS_KEY',
    updated_at = now()
where code = 'mirakl-mms';
```

Il `deep_link` è un'ipotesi: va confrontato con l'URL vero di un ordine
nel back office.

### 4. Migrazioni — verificare quali sono state applicate
Le migrazioni si eseguono a mano nell'editor SQL di Supabase e non c'è
un registro. Da 0001 a 0007. Per capire a che punto siamo:

```sql
select jsonb_pretty(value) from app_config where key = 'mail_ingest';
```

Deve contenere `domini_esclusi` (19 voci), `domini_notifica`
(`amazon.com`), `domini_avviso` (`amazon.it`), `avviso_sla_minuti`,
`avviso_tag`, `giorni_coda`. Se manca qualcosa, la migrazione
corrispondente non è stata eseguita — sono tutte idempotenti, si possono
rilanciare senza danno.

### 5. Pulizia dei dati sporchi
Il database contiene ancora conversazioni nate dalle prime letture, con
le regole vecchie:

```sql
-- guarda cosa c'è
select ca.code, t.state, count(*) from thread t
join channel_account ca on ca.id = t.account_id group by 1,2 order by 1,2;
```

Se ci sono ancora centinaia di thread `unmatched` su `amazon-it`, sono
residui: la rilettura li salta perché i messaggi risultano già presenti.
Per rifare da zero — nel database non c'è ancora lavoro umano da
salvare, nessuna risposta scritta, nessuna assegnazione:

```sql
delete from thread;                                    -- i messaggi vanno in cascata
delete from sync_state where account_id in (
  select id from channel_account where kind in ('email','mirakl'));
```

Poi il polling rilegge tutto da solo entro un minuto.

### 6. Pulizia dei corpi già importati
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
