# Esemplari Mirakl

**Questi file NON sono risposte reali.** Sono costruiti sullo schema
documentato di M11 (`GET /api/inbox/threads`), perché quando il
connettore è stato scritto nessun cliente Mirakl aveva ancora scritto e
l'API restituiva `{"data":[]}`.

Servono a verificare che il normalizzatore faccia quello che crediamo —
non che i nomi dei campi siano davvero questi.

## Il collaudo vero

Appena arriva la prima conversazione:

    npm run mirakl:check -- --forma

Non scrive niente nel database: stampa i nomi dei campi che l'API
restituisce davvero e li confronta con quelli che ci aspettiamo, senza
mostrare il contenuto dei messaggi. Se dice "nessuna stranezza", lo
schema documentato corrispondeva. Altrimenti elenca esattamente cosa
correggere.

Le stesse differenze finiscono comunque in `ingest_anomaly` durante la
sincronizzazione normale, con tipo che inizia per `mirakl_`:

    select tipo, count(*) from ingest_anomaly
    where tipo like 'mirakl_%' group by tipo;

Quando avremo una risposta vera, salvarla qui anonimizzata e cancellare
questo avviso.
