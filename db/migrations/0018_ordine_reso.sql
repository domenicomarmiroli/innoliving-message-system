-- =====================================================================
-- Hub Messaggi — migrazione 0018: spedizione di reso sull'ordine
--
-- Amazon manda una notifica quando un cliente apre una richiesta di reso
-- (`X-Space-Notification-Type: RETURN_REQUEST`), e nella stessa email, se
-- l'ha già autorizzata, include corriere e numero di tracciamento
-- dell'etichetta di rientro. È un'informazione diversa dalla spedizione
-- normale (`tracking_number`/`tracking_url`/`carrier`, che tracciano
-- l'invio AL cliente): qui viene DAL cliente, e va tenuta distinta anche
-- nel frontend — un "Reso" separato dalla spedizione in uscita.
--
-- Niente colonna URL: nessun modello di link per corriere è stato
-- richiesto, e costruirne uno senza un esemplare reale sarebbe indovinare
-- (vedi il DEBITO già dichiarato sul connettore Mirakl).
--
-- Da eseguire dopo la 0017. È idempotente.
-- =====================================================================

alter table "order"
  add column if not exists reso_carrier          text,
  add column if not exists reso_tracking_number   text;

comment on column "order".reso_carrier is
  'Corriere della spedizione di RESO (dal cliente a noi), da Amazon RETURN_REQUEST. Distinto da carrier, che è la spedizione in uscita.';
comment on column "order".reso_tracking_number is
  'Numero di tracciamento della spedizione di RESO, da Amazon RETURN_REQUEST. Distinto da tracking_number.';
