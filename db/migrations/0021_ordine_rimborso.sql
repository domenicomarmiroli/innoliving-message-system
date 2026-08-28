-- =====================================================================
-- Hub Messaggi — migrazione 0021: rimborsi emessi da Amazon
--
-- Amazon manda una notifica quando emette un rimborso al cliente
-- (X-Space-Notification-Type: REFUND_ISSUED), con l'importo e gli
-- articoli coinvolti. A differenza di una richiesta di reso, un
-- rimborso può ripetersi più volte sullo stesso ordine (rimborsi
-- parziali su articoli diversi, in email diverse) — quindi
-- rimborso_totale è una SOMMA cumulativa, non l'ultimo valore visto.
--
-- Da eseguire dopo la 0020. È idempotente.
-- =====================================================================

alter table "order"
  add column if not exists rimborso_totale     numeric(12,2),
  add column if not exists rimborso_emesso_at  timestamptz;

comment on column "order".rimborso_totale is
  'Somma cumulativa dei rimborsi Amazon notificati per questo ordine (REFUND_ISSUED). Non è il totale ordine, solo quanto rimborsato finora.';
comment on column "order".rimborso_emesso_at is
  'Data dell''ultimo rimborso notificato per questo ordine.';
