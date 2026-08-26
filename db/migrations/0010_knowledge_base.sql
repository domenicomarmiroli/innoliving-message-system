-- =====================================================================
-- Hub Messaggi — migrazione 0010: knowledge base per le bozze AI
--
-- Due modi di entrare in tabella: un documento caricato da un admin
-- (PDF o TXT, il worker estrae il testo) o una risposta di un operatore
-- segnalata come buon esempio. Recupero per il passo 07 (bozze AI) via
-- sovrapposizione di tag con quelli del thread — gli stessi tag che
-- fanno già da "intento classificato" (vedi threadIntent in Lovable):
-- nessuna ricerca semantica per ora, è un debito dichiarato, non
-- un'omissione.
--
-- Da eseguire nell'editor SQL di Supabase dopo la 0009. È idempotente.
-- =====================================================================

create table if not exists knowledge (
  id           uuid primary key default gen_random_uuid(),
  titolo       text        not null,
  -- Il testo che entra davvero nel prompt: estratto dal PDF/TXT, o il
  -- corpo della risposta segnalata come esempio.
  contenuto    text        not null,
  fonte        text        not null default 'documento'
                 check (fonte in ('documento', 'esempio_operatore')),
  file_nome    text,
  storage_path text,
  tag          text[]      not null default '{}'::text[],
  attivo       boolean     not null default true,
  creato_da    uuid        references agent(id) on delete set null,
  -- Solo per fonte = 'esempio_operatore': il messaggio da cui arriva.
  message_id   uuid        references message(id) on delete set null,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);

create index if not exists knowledge_tag_idx    on knowledge using gin (tag);
create index if not exists knowledge_attivo_idx on knowledge (attivo);

alter table knowledge enable row level security;

-- ---------------------------------------------------------------------
-- Verifica
-- ---------------------------------------------------------------------
select column_name, data_type from information_schema.columns
where table_name = 'knowledge' order by ordinal_position;

-- =====================================================================
-- NOTA PER CHI TOCCA LOVABLE
--
-- Due scritture dirette su Supabase, stessa categoria di tag/note interne
-- (dati che non toccano nessuna piattaforma esterna):
--  1. segnalare una risposta inviata come esempio da aggiungere alla KB
--     (insert in knowledge con fonte = 'esempio_operatore');
--  2. gestione della lista (elenco, disattivazione, modifica tag) dal
--     pannello admin.
-- Il CARICAMENTO di un documento (PDF/TXT) invece passa dal worker
-- (POST /knowledge): serve lì per estrarre il testo dal file, cosa che
-- non ha senso far fare al browser. Riservato al ruolo admin.
--
-- Serviranno policy RLS di SELECT/INSERT/UPDATE su knowledge per gli
-- utenti autenticati (idealmente ristrette al ruolo admin per la
-- scrittura) — fornirle quando servono, come già fatto per Storage e
-- le note interne, non indovinarle qui.
-- =====================================================================
