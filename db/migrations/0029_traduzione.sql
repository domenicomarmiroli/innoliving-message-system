-- =====================================================================
-- Hub Messaggi — migrazione 0029: traduzione dei messaggi
--
-- Due colonne su `message`, entrambe facoltative: chi legge la tabella
-- senza conoscerle (l'interfaccia prima dell'aggiornamento) continua a
-- funzionare come prima.
--
--   lingua        codice ISO 639-1 a due lettere ('it', 'de', 'fr'...)
--                 della lingua in cui è scritto `body_text`.
--   body_text_it  la versione italiana, quando la lingua non è
--                 l'italiano. Null se il messaggio è già in italiano.
--
-- La convenzione vale nei due sensi:
--   - messaggio del cliente in tedesco: body_text = l'originale tedesco,
--     body_text_it = la traduzione per l'operatore;
--   - nostra risposta tradotta: body_text = il testo davvero spedito (in
--     tedesco), body_text_it = l'italiano scritto dall'operatore.
-- `body_text` resta quindi sempre ciò che è passato fra noi e il
-- cliente, come per gli allegati in uscita: si registra cosa il cliente
-- ha ricevuto, non cosa l'operatore aveva in mente.
--
-- `lingua is null` su un messaggio in arrivo vuol dire "non ancora
-- esaminato": è il segnale che il worker usa per sapere cosa tradurre.
-- L'indice parziale tiene quella ricerca veloce senza pesare sul resto.
--
-- Da eseguire nell'editor SQL di Supabase dopo la 0028, PRIMA del
-- deploy del worker che la usa. È idempotente.
-- =====================================================================

alter table message add column if not exists lingua text;
alter table message add column if not exists body_text_it text;

create index if not exists message_da_tradurre_idx
  on message (created_at desc)
  where lingua is null and direction = 'in' and author_kind = 'customer';

-- ---------------------------------------------------------------------
-- Verifica
-- ---------------------------------------------------------------------
-- select column_name from information_schema.columns
-- where table_name = 'message' and column_name in ('lingua', 'body_text_it');
