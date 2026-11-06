-- =====================================================================
-- Hub Messaggi — migrazione 0048: etichetta di reso da numero d'ordine,
-- senza ticket
--
-- Serve per i canali non integrati (BricoBravo) e per ogni caso in cui
-- l'operatore vuole l'etichetta prima che esista un ticket: si dà il numero
-- d'ordine, il worker genera lo stesso foglio di reso del ticket e lo
-- operatore la manda al cliente a mano.
--
--   etichetta_reso.thread_id   ora facoltativo (resta unico per (thread, tipo)
--                              quando c'è: in Postgres i NULL non si scontrano)
--   canale, numero_ordine      chiave dell'etichetta senza ticket
--   nome_cliente               nome digitato quando l'ordine non è nell'Hub
--   indice unico parziale      (canale, numero_ordine, tipo) dove thread_id è
--                              NULL: premere due volte non crea due spedizioni
--
-- Da eseguire PRIMA del deploy del worker che la usa. Idempotente.
-- =====================================================================

alter table etichetta_reso alter column thread_id drop not null;

alter table etichetta_reso add column if not exists canale        text;
alter table etichetta_reso add column if not exists numero_ordine text;
alter table etichetta_reso add column if not exists nome_cliente  text;

-- Senza ticket servono canale e numero d'ordine; con il ticket non cambia niente.
alter table etichetta_reso drop constraint if exists etichetta_reso_chiave_check;
alter table etichetta_reso add constraint etichetta_reso_chiave_check
  check (thread_id is not null or (canale is not null and numero_ordine is not null));

create unique index if not exists etichetta_reso_ordine_tipo_key
  on etichetta_reso (canale, numero_ordine, tipo)
  where thread_id is null;

-- Verifica
select count(*) as etichette_con_ticket from etichetta_reso where thread_id is not null;
