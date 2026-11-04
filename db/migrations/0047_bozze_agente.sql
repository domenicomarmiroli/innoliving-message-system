-- =====================================================================
-- Hub Messaggi — migrazione 0047: bozze AI con azione consigliata
--
-- La bozza ora ha due parti separate: il testo per il cliente
-- (draft_text, come prima) e l'azione consigliata per l'operatore, con
-- la nota riservata. Il sistema non esegue mai l'azione.
--   famiglia           il caso riconosciuto dal TESTO del cliente
--   azione             {tipo, testo, condizione}
--   nota_operatore     solo per l'operatore (costo, alternative, dati mancanti)
--   decide_domenico    l'agente non propone, passa la mano
--   trigger_message_id l'ultimo messaggio cliente a cui la bozza risponde:
--                      evita di rigenerare (e pagare) la stessa bozza
--
-- Da eseguire nell'editor SQL di Supabase PRIMA del deploy. Idempotente.
-- =====================================================================

alter table ai_draft add column if not exists famiglia text;
alter table ai_draft add column if not exists azione jsonb;
alter table ai_draft add column if not exists nota_operatore text;
alter table ai_draft add column if not exists decide_domenico boolean not null default false;
alter table ai_draft add column if not exists trigger_message_id uuid references message(id) on delete set null;

create index if not exists ai_draft_trigger_idx on ai_draft (thread_id, trigger_message_id);

select column_name from information_schema.columns
where table_name = 'ai_draft' and column_name in
  ('famiglia','azione','nota_operatore','decide_domenico','trigger_message_id');

-- Valori specifici dell'azienda per il prompt delle bozze (regola 7: mai nel
-- codice). Modificabili da qui senza rilasciare il worker.
insert into app_config (key, value)
values ('bozze_agente', jsonb_build_object(
  'azienda', 'Innoliving',
  'telefono_assistenza', '071-2133550',
  'sito_ricambi', 'inshopping.it',
  'marchio_sito', 'Inshopping'
))
on conflict (key) do nothing;
