-- =====================================================================
-- Hub Messaggi — migrazione 0019: a chi è andata una risposta Mirakl
--
-- Un thread Mirakl può avere due controparti — il cliente e l'operatore
-- del marketplace stesso (vedi CLAUDE.md, connettore Mirakl) — e
-- l'agente sceglie a chi rispondere ad ogni invio (mirakl_destinatari in
-- POST /threads/reply). Finora quella scelta non veniva salvata da
-- nessuna parte dopo l'invio: guardando la cronologia non si capiva più
-- se un messaggio era andato al cliente, all'operatore, o a entrambi —
-- un problema vero quando le due comunicazioni devono essere diverse.
--
-- Colonna nullable e specifica del canale, come già fa la tabella per
-- altri campi non universali (delivery_state, match_strategy): null per
-- ogni messaggio non-Mirakl e per i messaggi in entrata.
--
-- Da eseguire dopo la 0018. È idempotente.
-- =====================================================================

alter table message
  add column if not exists mirakl_destinatari text[];

comment on column message.mirakl_destinatari is
  'Solo per messaggi in uscita su thread Mirakl: a chi è stata mandata la risposta (CUSTOMER, OPERATOR, o entrambi). Null altrove.';
