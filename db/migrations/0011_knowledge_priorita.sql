-- =====================================================================
-- Hub Messaggi — migrazione 0011: priorità e voci scritte a mano
--
-- Due aggiunte alla knowledge base (0010):
--  - priorita: quanto pesa una voce nel recupero. Una procedura come
--    "se il cliente segnala un danno, chiedi sempre le foto" deve
--    prevalere su una nota generica con lo stesso tag.
--  - fonte 'manuale': una voce scritta direttamente dal pannello admin,
--    non caricata da file né presa da una risposta operatore. Una
--    "procedura" non è un tipo a parte: è una voce manuale con i tag e
--    la priorità giusti — niente tassonomia rigida in più.
--
-- Da eseguire nell'editor SQL di Supabase dopo la 0010. È idempotente.
-- =====================================================================

alter table knowledge add column if not exists priorita integer not null default 0;

alter table knowledge drop constraint if exists knowledge_fonte_check;
alter table knowledge add constraint knowledge_fonte_check
  check (fonte in ('documento', 'manuale', 'esempio_operatore'));

comment on column knowledge.priorita is
  'Più alto = pesa di più nel recupero per la bozza AI. 0 = normale.';

-- ---------------------------------------------------------------------
-- Verifica
-- ---------------------------------------------------------------------
select column_name, data_type, column_default
from information_schema.columns
where table_name = 'knowledge' and column_name = 'priorita';

-- =====================================================================
-- NOTA PER CHI TOCCA LOVABLE — pannello admin
--
-- Servono policy RLS per il ruolo admin su knowledge:
--  - SELECT: per elencare le voci nel pannello;
--  - INSERT: per le voci manuali e per "segnala come esempio"
--    (fonte = 'esempio_operatore', quest'ultima anche da un agente non
--    admin, è la sua stessa risposta che segnala — valuta se distinguere);
--  - UPDATE: per correggere testo, tag, priorità, o disattivare
--    (attivo = false — MAI una delete: la voce potrebbe essere già
--    stata usata in una bozza passata, e ingest_anomaly insegna che
--    tenere traccia costa meno che scoprire dopo di aver perso qualcosa).
-- Fornirle quando servono davvero, con l'errore preciso davanti, non
-- indovinarle qui.
-- =====================================================================
