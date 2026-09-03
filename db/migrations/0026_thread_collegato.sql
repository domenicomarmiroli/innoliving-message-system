-- =====================================================================
-- Hub Messaggi — migrazione 0026: ticket collegati
--
-- Un agente, dal ticket cliente, può scrivere una email a un indirizzo
-- esterno (corriere, assistenza) senza uscire dal sistema: si apre un
-- NUOVO ticket, collegato a quello di partenza — come i "linked
-- tickets" di Zendesk, visibili nella barra laterale del ticket cliente.
--
-- Un solo campo, sul thread "figlio" (quello verso corriere/assistenza),
-- che punta al thread "padre" (il ticket cliente). Per la vista dal
-- padre verso i figli si interroga al contrario:
--   select * from thread where linked_thread_id = :padre_id
--
-- Nessuna modifica allo stato: thread.state ha già il valore
-- 'pending_internal' nel vincolo fin dalla migrazione 0001, mai usato
-- da nessun codice finora — è la scelta naturale per "in attesa" di
-- una risposta che non è il cliente.
--
-- Da eseguire nell'editor SQL di Supabase dopo la 0025. È idempotente.
-- =====================================================================

alter table thread
  add column if not exists linked_thread_id uuid references thread(id) on delete set null;

create index if not exists thread_linked_thread_idx
  on thread (linked_thread_id) where linked_thread_id is not null;

-- ---------------------------------------------------------------------
-- Verifica
-- ---------------------------------------------------------------------
select column_name, data_type, is_nullable
from information_schema.columns
where table_name = 'thread' and column_name = 'linked_thread_id';
