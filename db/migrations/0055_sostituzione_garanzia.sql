-- =====================================================================
-- Hub Messaggi — migrazione 0055: prodotto sostitutivo in garanzia.
--
-- Il cliente ha rimandato il prodotto difettoso: dal ticket l'operatore
-- crea su Shopify l'ordine del sostitutivo a 0 euro, oppure, se il prodotto
-- non è disponibile, un codice sconto monouso del valore dello scontrino.
--
-- - thread.valore_scontrino: il valore del prodotto sullo scontrino. Lo
--   manda il portale garanzie quando riesce a leggerlo, o lo scrive
--   l'operatore guardando lo scontrino. Non si mostra mai al cliente.
-- - sostituzione: una riga per ticket. Nasce 'in_corso' PRIMA della
--   chiamata a Shopify: un secondo clic non crea un secondo ordine.
-- - app_config.sostituzione: tag, prefisso e durata del codice sconto.
--
-- Da eseguire PRIMA del deploy del worker che la usa. Idempotente.
-- =====================================================================

alter table thread add column if not exists valore_scontrino numeric(10,2)
  check (valore_scontrino is null or valore_scontrino >= 0);
alter table thread add column if not exists valore_scontrino_fonte text
  check (valore_scontrino_fonte is null or valore_scontrino_fonte in ('portale', 'operatore'));

create table if not exists sostituzione (
  id                 uuid primary key default gen_random_uuid(),
  thread_id          uuid not null references thread(id) on delete cascade,
  tipo               text not null check (tipo in ('ordine', 'codice_sconto')),
  stato              text not null default 'in_corso' check (stato in ('in_corso', 'fatta', 'errore')),
  sku                text,
  variant_gid        text,
  -- ordine
  shopify_order_gid  text,
  shopify_order_name text,
  order_id           uuid references "order"(id) on delete set null,
  indirizzo          jsonb,
  -- codice sconto
  codice_sconto      text,
  discount_gid       text,
  importo            numeric(10,2),
  scade_il           timestamptz,
  errore             text,
  agent_id           uuid,
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now()
);

-- Un solo sostitutivo per ticket (ordine o codice sconto, non tutti e due).
-- Una riga in errore si può ritentare: la si aggiorna, non se ne crea un'altra.
create unique index if not exists sostituzione_thread_uniq on sostituzione (thread_id);

alter table sostituzione enable row level security;
drop policy if exists sostituzione_agent_select on sostituzione;
create policy sostituzione_agent_select on sostituzione for select to authenticated using (public.is_agent());

insert into app_config (key, value) values (
  'sostituzione',
  '{
     "suffisso_sku": "IS",
     "tag_ordine": "sostituzione-garanzia",
     "prefisso_codice": "GARANZIA",
     "giorni_validita_codice": 90,
     "invia_conferma_ordine": false,
     "invia_conferma_spedizione": true,
     "valuta": "EUR"
   }'::jsonb
) on conflict (key) do nothing;

-- Verifica
select column_name from information_schema.columns
where table_name = 'thread' and column_name like 'valore_scontrino%';
select key, value from app_config where key = 'sostituzione';
