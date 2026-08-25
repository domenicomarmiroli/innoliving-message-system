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

1. **Lo schema del database NON appartiene a questo repo.** È di proprietà del
   progetto Lovable. Il file `db/schema.sql` è una copia in sola lettura,
   rigenerata a mano dopo ogni modifica fatta in Lovable. Non scrivere mai
   migrazioni, non fare mai `ALTER TABLE`, non fare `CREATE TABLE`.

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

## Stato attuale
Fatto: scheletro, configurazione validata, connessione al database, `/health`,
test di configurazione e di replicabilità, Dockerfile e render.yaml.
Prossimo passo (04 del runbook): connettore Shopify — webhook con verifica
HMAC, backfill paginato, normalizzazione dei quattro canali, upsert
idempotente con gestione del duplicato Amazon noto.
