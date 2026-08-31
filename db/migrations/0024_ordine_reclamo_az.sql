-- =====================================================================
-- Hub Messaggi — migrazione 0024: reclami dalla A alla Z su un ordine
--
-- Amazon manda una notifica quando un cliente apre un reclamo di
-- Garanzia dalla A alla Z (X-Space-Notification-Type:
-- A_Z_CLAIM_RESPONDENT_NOTIFY) — verificato su un esemplare reale che
-- il vecchio meccanismo (avviso per testo nell'oggetto, migrazione 0007)
-- non intercettava: l'oggetto di questa email è "Richiesta di rimborso
-- ricevuta per l'ordine ...", non contiene "dalla A alla Z" da nessuna
-- parte — solo il CORPO lo dice. Con la sola corrispondenza sul testo
-- dell'oggetto, questo reclamo sarebbe finito nel tag generico
-- "avviso-piattaforma", non "garanzia-a-z". Stesso motivo per cui resi
-- e rimborsi (migrazioni 0018/0021) usano l'header invece del testo.
--
-- order.reclamo_az_importo / order.reclamo_az_ricevuto_at: stesso
-- principio di reso_richiesto_at (migrazione 0020) — sull'ordine, non
-- sul thread, visibile su qualunque ticket collegato. coalesce tiene la
-- prima data vista: un reclamo è un evento che ha senso una volta sola
-- per ordine, come un reso, non cumulativo come i rimborsi parziali.
--
-- Da eseguire dopo la 0023. È idempotente.
-- =====================================================================

alter table "order"
  add column if not exists reclamo_az_importo      numeric(12,2),
  add column if not exists reclamo_az_ricevuto_at  timestamptz;

comment on column "order".reclamo_az_importo is
  'Importo del reclamo di Garanzia dalla A alla Z notificato da Amazon.';
comment on column "order".reclamo_az_ricevuto_at is
  'Quando è arrivata la notifica di reclamo A-to-Z. Non sovrascritta da notifiche successive sullo stesso ordine (coalesce): resta la data della prima.';
