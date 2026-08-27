-- =====================================================================
-- Hub Messaggi — migrazione 0013: indirizzi di spedizione e fatturazione
--
-- Il connettore Shopify non li estraeva: né il webhook né la query
-- GraphQL del backfill/allineamento li chiedevano. Sono per ordine, non
-- per cliente — un cliente può spedire a indirizzi diversi da un ordine
-- all'altro (regalo, seconda casa) — quindi stanno su "order", non su
-- "customer". jsonb e non colonne singole: la forma è quella che dà
-- Shopify (nome, telefono, indirizzo1/2, città, provincia, cap, paese),
-- fissa ma non vale la pena normalizzare in otto colonne per un dato che
-- si legge, non si interroga.
--
-- Da eseguire nell'editor SQL di Supabase dopo la 0012. È idempotente.
-- Gli ordini già importati restano con questi campi null finché non
-- vengono ritoccati dal giro periodico o da un nuovo backfill: non è un
-- problema, i dati non sono persi, semplicemente non li avevamo mai
-- chiesti a Shopify finora.
-- =====================================================================

alter table "order" add column if not exists shipping_address jsonb;
alter table "order" add column if not exists billing_address jsonb;

comment on column "order".shipping_address is
  'Indirizzo di spedizione: {nome, telefono, indirizzo1, indirizzo2, citta, provincia, cap, paese}. Null se non ancora risincronizzato dopo questa migrazione.';
comment on column "order".billing_address is
  'Indirizzo di fatturazione, stessa forma di shipping_address.';

-- ---------------------------------------------------------------------
-- Verifica
-- ---------------------------------------------------------------------
select column_name, data_type
from information_schema.columns
where table_name = 'order' and column_name in ('shipping_address', 'billing_address');
