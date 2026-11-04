-- Da eseguire sul progetto PIM (pim-innoliving), NON su Hub Messaggi.
-- Dà al ruolo hub_assistenza il costo di acquisto di un prodotto, in sola
-- lettura, per la nota all'operatore delle bozze AI. Oggi il ruolo vede
-- solo le funzioni assistenza_* e nessuna tabella, quindi NON vede costi.
-- Nota: il PIM ha solo product_costs.costo_acquisto, non un "landed"
-- completo (trasporto, dazi). Se il landed si calcola altrove, sostituire
-- l'espressione qui sotto. Idempotente.

create or replace function public.assistenza_costo_prodotto(p_sku text)
returns jsonb
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select jsonb_build_object('costo', c.costo_acquisto, 'valuta', coalesce(c.valuta, 'EUR'))
  from products p
  join product_costs c on c.product_id = p.id
  where upper(p.sku) = upper(trim(p_sku)) and c.costo_acquisto is not null
$$;

revoke all on function public.assistenza_costo_prodotto(text) from public;
grant execute on function public.assistenza_costo_prodotto(text) to hub_assistenza;
