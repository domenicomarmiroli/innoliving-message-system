-- =====================================================================
-- Hub Messaggi — migrazione 0012: link di riferimento nella knowledge base
--
-- I marketplace (Amazon e non solo) pubblicano le proprie linee guida su
-- pagine web ufficiali. Il worker non le va a leggere da solo — nessun
-- fetch a tempo di bozza, sarebbe lento e inaffidabile — ma un operatore
-- può linkarle da una voce, scrivendo di suo pugno cosa contano dire di
-- quella pagina. Il link è un riferimento per chi legge (operatore o
-- modello), il testo scritto a mano resta l'unica fonte che entra
-- davvero nel prompt.
--
-- Da eseguire nell'editor SQL di Supabase dopo la 0011. È idempotente.
-- =====================================================================

alter table knowledge add column if not exists url text;

comment on column knowledge.url is
  'Link di riferimento facoltativo (es. pagina di linee guida di un marketplace). Il worker non lo scarica mai: conta solo il testo in contenuto, scritto da chi ha creato la voce.';

-- ---------------------------------------------------------------------
-- Verifica
-- ---------------------------------------------------------------------
select column_name, data_type
from information_schema.columns
where table_name = 'knowledge' and column_name = 'url';
