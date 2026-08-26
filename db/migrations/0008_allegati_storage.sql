-- =====================================================================
-- Hub Messaggi — migrazione 0008: gli allegati diventano byte veri
--
-- Finora attachment registrava solo i metadati (nome, mime, dimensione,
-- checksum): il contenuto non veniva mai salvato. Questa migrazione
-- prepara il posto dove i byte vanno davvero a finire.
--
-- Da eseguire nell'editor SQL di Supabase dopo la 0007. È idempotente.
-- =====================================================================

-- ---------------------------------------------------------------------
-- 1. Dimensioni immagine, per dimensionare le miniature senza doverle
--    riaprire.
-- ---------------------------------------------------------------------
alter table attachment add column if not exists larghezza integer;
alter table attachment add column if not exists altezza   integer;

-- ---------------------------------------------------------------------
-- 2. Il bucket privato. Non pubblico: gli allegati possono contenere
--    foto di documenti o dati del cliente, e vanno serviti solo con URL
--    firmati a tempo, mai con un link diretto e permanente.
-- ---------------------------------------------------------------------
insert into storage.buckets (id, name, public)
values ('allegati', 'allegati', false)
on conflict (id) do nothing;

-- ---------------------------------------------------------------------
-- 3. Verifica
-- ---------------------------------------------------------------------
select column_name from information_schema.columns
where table_name = 'attachment' and column_name in ('larghezza', 'altezza');

select id, name, public from storage.buckets where id = 'allegati';

-- =====================================================================
-- NOTA PER CHI TOCCA LOVABLE — la policy RLS di lettura
--
-- Il worker scrive nel bucket con la service_role key, che bypassa RLS
-- da sola: non serve nessuna policy perché l'ingestione funzioni.
-- Ma se l'interfaccia deve mostrare un'anteprima chiedendo un URL
-- firmato direttamente a Supabase (senza passare dal worker), serve una
-- policy SELECT su storage.objects per gli utenti autenticati, con
-- bucket_id = 'allegati'. Questa non è responsabilità di questo repo:
-- le policy per gli utenti autenticati le gestisce Lovable (vedi
-- CLAUDE.md, "Chiavi Supabase: chi tiene cosa").
-- =====================================================================
