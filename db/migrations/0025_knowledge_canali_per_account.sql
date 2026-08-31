-- =====================================================================
-- Hub Messaggi — migrazione 0025: knowledge.canali per operatore, non
-- per genere di canale
--
-- La migrazione 0023 aveva definito knowledge.canali come lista di
-- KIND di channel_account ('shopify','amazon','mirakl',...). Domenico
-- ha segnalato che non basta: due operatori Mirakl diversi (Leroy
-- Merlin e MediaMarkt, oggi entrambi kind='mirakl') hanno logiche di
-- comunicazione diverse, e una voce pensata per l'uno non deve valere
-- per l'altro solo perché condividono la piattaforma.
--
-- Nessuna modifica di schema: la colonna resta text[], NULL o vuoto
-- resta "vale per tutti". Cambia solo COSA contiene: non più il kind,
-- ma channel_account.code (es. 'mirakl-lmfr', non 'mirakl') — così due
-- operatori sulla stessa piattaforma restano distinti. generaBozza()
-- filtra ora su ca.code, non più su ca.kind.
--
-- L'unica voce esistente che usava questo campo (creata nella finestra
-- fra la 0023 e questa) andrà ricontrollata a mano: se aveva "mirakl"
-- selezionato genericamente, va corretta scegliendo l'operatore giusto
-- (Leroy Merlin o MediaMarkt) dal pannello.
--
-- Da eseguire dopo la 0024. È idempotente (solo un commento).
-- =====================================================================

comment on column knowledge.canali is
  'Codici di channel_account (channel_account.code, es. mirakl-lmfr — non il kind) a cui si applica questa voce. NULL o vuoto = vale per tutti gli operatori/canali.';
