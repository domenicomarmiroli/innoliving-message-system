-- =====================================================================
-- Hub Messaggi — migrazione 0031: email dell'ordine
--
-- Serve all'agente vocale per verificare chi chiama: numero d'ordine più
-- email OPPURE CAP. Il CAP c'era già (shipping_address, 0013), l'email
-- non era mai stata chiesta a Shopify.
--
-- Sugli ordini dei marketplace l'email di Shopify è di solito un alias
-- del relay, che il cliente non conosce: lì la verifica passa dal CAP.
--
-- Da eseguire nell'editor SQL di Supabase dopo la 0030 e PRIMA del
-- deploy del worker che la scrive: senza la colonna, il salvataggio
-- degli ordini fallirebbe. È idempotente.
--
-- Dopo il deploy, per completare gli ordini già in archivio (dalla Shell
-- di Render):
--   npm run shopify:sync -- --creati-dal 2025-10-01
-- =====================================================================

alter table "order" add column if not exists email text;

comment on column "order".email is
  'Email dell''ordine secondo Shopify. Sugli ordini marketplace è spesso un alias del relay. Usata dalla verifica telefonica.';

-- ---------------------------------------------------------------------
-- Verifica: una riga
-- ---------------------------------------------------------------------
select column_name, data_type
from information_schema.columns
where table_name = 'order' and column_name = 'email';
