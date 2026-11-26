-- 0056: applicata a mano su Hub Messaggi PRO il 2026-11-26.
--
-- 1) Campo calcolato `solo_notifica` per la coda "Tutti i ticket".
--    Prima l'interfaccia mandava nell'indirizzo l'elenco di tutti i thread
--    solo notifica; a 618 id l'indirizzo ha superato il limite e la coda
--    e' tornata vuota con errore 400. Ora si filtra con solo_notifica=false.
create or replace function public.solo_notifica(t public.thread)
returns boolean language sql stable security invoker set search_path = public as $$
  select coalesce(t.tags && array['rimborso-emesso','reso-richiesto']::text[], false)
     and not exists (
       select 1 from public.message m
       where m.thread_id = t.id and m.direction = 'in' and m.author_kind = 'customer'
     );
$$;
grant execute on function public.solo_notifica(public.thread) to authenticated;

-- 2) Indici per la ricerca libera della coda (ilike '%termine%').
--    Senza, ogni ricerca apriva il raw di tutti i messaggi: 5 s solo sui
--    messaggi. Con gli indici trigram: circa 1 ms.
create extension if not exists pg_trgm with schema extensions;
create index if not exists message_cerca_body_trgm on public.message using gin (body_text extensions.gin_trgm_ops);
create index if not exists message_cerca_nome_trgm on public.message using gin ((raw->>'nome') extensions.gin_trgm_ops);
create index if not exists message_cerca_ordine_trgm on public.message using gin ((raw->>'numero_ordine_dichiarato') extensions.gin_trgm_ops);
create index if not exists message_cerca_from_trgm on public.message using gin ((raw->>'from') extensions.gin_trgm_ops);
create index if not exists message_cerca_replyto_trgm on public.message using gin ((raw->>'reply_to') extensions.gin_trgm_ops);
create index if not exists message_cerca_to_trgm on public.message using gin ((raw->>'to') extensions.gin_trgm_ops);
create index if not exists order_cerca_external_trgm on public."order" using gin (external_order_id extensions.gin_trgm_ops);
create index if not exists order_cerca_shopify_trgm on public."order" using gin (shopify_name extensions.gin_trgm_ops);
create index if not exists thread_cerca_subject_trgm on public.thread using gin (subject extensions.gin_trgm_ops);
create index if not exists thread_order_idx on public.thread (order_id) where order_id is not null;
create index if not exists thread_identity_idx on public.thread (identity_id) where identity_id is not null;

notify pgrst, 'reload schema';
