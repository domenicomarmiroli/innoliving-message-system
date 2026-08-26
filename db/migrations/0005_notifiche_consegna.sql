-- =====================================================================
-- Hub Messaggi — migrazione 0005: gli avvisi di mancata consegna
--
-- Amazon manda una email quando un nostro messaggio non raggiunge
-- l'acquirente. Non è una richiesta — non c'è niente a cui rispondere —
-- ma dice una cosa che serve sapere: quel cliente non ha ricevuto la
-- comunicazione.
--
-- Quindi non diventa un ticket, ma nemmeno sparisce: viene annotata
-- sulla conversazione di quell'ordine, che torna visibile con il tag
-- `consegna-fallita`.
--
-- Da eseguire dopo la 0004. È idempotente.
-- =====================================================================

update app_config
set value = value || jsonb_build_object(
      'domini_notifica', jsonb_build_array('amazon.com')
    ),
    updated_at = now()
where key = 'mail_ingest';

-- ---------------------------------------------------------------------
-- Verifica
-- ---------------------------------------------------------------------
select value from app_config where key = 'mail_ingest';

-- ---------------------------------------------------------------------
-- Dopo il primo giro, per vedere se l'aggancio funziona:
--
--   -- conversazioni con una risposta non arrivata al cliente
--   select count(*) from thread where 'consegna-fallita' = any(tags);
--
--   -- notifiche che NON siamo riusciti ad agganciare a un ordine
--   select tipo, count(*) from ingest_anomaly
--   where tipo like 'notifica_%' group by tipo;
--
-- Se il secondo numero è alto, vuol dire che il numero d'ordine non si
-- trova dove lo cerchiamo: serve un esemplare vero per capire dove sta.
-- ---------------------------------------------------------------------
