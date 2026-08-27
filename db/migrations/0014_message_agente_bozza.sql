-- =====================================================================
-- Hub Messaggi — migrazione 0014: chi ha spedito un messaggio, e da
-- quale bozza AI (se c'era)
--
-- Due lacune scoperte insieme costruendo la dashboard di reportistica:
--
-- 1. `/threads/reply` aggiorna già ai_draft.outcome/final_text, ma un
--    messaggio spedito non porta il verso opposto: da lì non si risale
--    a QUALE bozza l'ha originato. Serve per l'utilizzo dell'AI per
--    agente.
--
-- 2. Chi ha spedito un messaggio in uscita oggi si trova solo scavando
--    in audit_log (azione='risposta_inviata', dati->>'message_id') —
--    fragile per una query di reportistica che gira spesso. agent_id
--    diretto su message è il dato che serve davvero; audit_log resta
--    per l'audit generico, non si tocca.
--
-- Entrambe on delete set null, non cascade: se una bozza o un agente
-- venissero mai cancellati, il messaggio storico deve restare, solo
-- senza più il collegamento.
--
-- Da eseguire nell'editor SQL di Supabase dopo la 0013. È idempotente.
-- =====================================================================

alter table message add column if not exists draft_id uuid references ai_draft(id) on delete set null;
alter table message add column if not exists agent_id uuid references agent(id) on delete set null;

create index if not exists message_draft_idx on message (draft_id) where draft_id is not null;
create index if not exists message_agent_idx on message (agent_id) where agent_id is not null;

-- ---------------------------------------------------------------------
-- Verifica
-- ---------------------------------------------------------------------
select column_name, data_type
from information_schema.columns
where table_name = 'message' and column_name in ('draft_id', 'agent_id');
