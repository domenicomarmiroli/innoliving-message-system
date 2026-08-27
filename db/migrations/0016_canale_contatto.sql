-- =====================================================================
-- Hub Messaggi — migrazione 0016: canale "contatto" per i siti esterni
--
-- I siti con l'agente AI nella pagina "Contattaci" (fatti in Lovable,
-- brand diversi dal marketplace principale) devono poter aprire un
-- ticket qui. Non è email né un marketplace: un nuovo genere di canale,
-- 'contatto', con un channel_account per ogni sito/brand — stesso
-- pattern già usato per gli operatori Mirakl: un brand in più è una riga
-- di SQL più una variabile d'ambiente, mai un URL o un nome scritto nel
-- codice.
--
-- Da eseguire nell'editor SQL di Supabase dopo la 0015. È idempotente.
-- =====================================================================

alter table channel_account drop constraint if exists channel_account_kind_check;
alter table channel_account add constraint channel_account_kind_check
  check (kind in ('shopify', 'amazon', 'mirakl', 'tiktok', 'email', 'contatto'));

-- ---------------------------------------------------------------------
-- Verifica
-- ---------------------------------------------------------------------
select conname, pg_get_constraintdef(oid)
from pg_constraint
where conrelid = 'channel_account'::regclass and conname = 'channel_account_kind_check';

-- =====================================================================
-- NOTA — come aggiungere un sito
--
-- Un channel_account per sito, kind = 'contatto'. `secret_ref` NON si usa
-- per questo canale (ripensato dopo il primo giro con più brand: un
-- token per riga come per Mirakl era solo un'occasione in più di
-- sbagliare la configurazione, senza un vero bisogno di isolamento fra
-- siti della stessa infrastruttura). Un solo CONTATTO_TOKEN in
-- .env.example autentica tutti i brand; il brand del ticket resta
-- sempre quello nell'URL (:codice), non nel token.
--
--   insert into channel_account (kind, code, display_name, locale, config)
--   values ('contatto', 'contatto-<brand>', '<Nome del brand>', 'it', '{}'::jsonb);
--
-- Il TOKEN condiviso va impostato UNA volta come variabile d'ambiente su
-- Render (CONTATTO_TOKEN) — MAI nel codice, MAI nel bundle del sito che
-- chiama l'endpoint (che deve girare lato server, non nel browser: un
-- token nel JavaScript del sito sarebbe leggibile da chiunque).
-- =====================================================================
