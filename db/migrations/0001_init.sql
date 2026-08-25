-- =====================================================================
-- Hub Messaggi — migrazione iniziale
--
-- Da eseguire UNA VOLTA nell'editor SQL del progetto Supabase:
--   Supabase → SQL Editor → New query → incolla tutto → Run
--
-- Crea schema, vincoli, indici, Row Level Security e i dati di partenza.
-- È idempotente: rieseguirlo non rompe nulla.
-- =====================================================================

create extension if not exists pgcrypto;

-- =====================================================================
-- 1. TABELLE
-- =====================================================================

create table if not exists app_config (
  key         text primary key,
  value       jsonb       not null default '{}'::jsonb,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

create table if not exists agent (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid unique,                       -- corrisponde ad auth.users.id
  nome        text        not null,
  email       text,
  ruolo       text        not null default 'agente',   -- agente | admin | cat
  active      boolean     not null default true,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

create table if not exists channel_account (
  id            uuid primary key default gen_random_uuid(),
  kind          text        not null check (kind in ('shopify','amazon','mirakl','tiktok','email')),
  code          text        not null unique,
  display_name  text        not null,
  locale        text        not null default 'it',
  transport     text,
  -- config: endpoint, shop_id, mailbox, modelli di URL verso la
  -- piattaforma di vendita e verso i corrieri
  config        jsonb       not null default '{}'::jsonb,
  -- secret_ref: puntatore al vault. MAI la chiave in chiaro.
  secret_ref    text,
  sla_minutes   integer     not null default 1440,
  active        boolean     not null default true,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);

create table if not exists customer (
  id          uuid primary key default gen_random_uuid(),
  nome        text,
  email       text,
  telefono    text,
  note        text,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

create table if not exists channel_identity (
  id            uuid primary key default gen_random_uuid(),
  account_id    uuid        not null references channel_account(id) on delete cascade,
  external_id   text        not null,
  display_name  text,
  customer_id   uuid        references customer(id) on delete set null,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  constraint channel_identity_account_external_key unique (account_id, external_id)
);

create table if not exists "order" (
  id                 uuid primary key default gen_random_uuid(),
  channel            text        not null,
  external_order_id  text        not null,
  shopify_gid        text,
  shopify_name       text,
  operator           text,
  buyer_alias        text,
  placed_at          timestamptz,
  financial_status   text,
  fulfillment_status text,
  tracking_number    text,
  tracking_url       text,
  carrier            text,
  total              numeric(12,2),
  currency           text,
  raw                jsonb       not null default '{}'::jsonb,
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now(),
  constraint order_channel_external_key unique (channel, external_order_id)
);

create table if not exists order_line (
  id          uuid primary key default gen_random_uuid(),
  order_id    uuid        not null references "order"(id) on delete cascade,
  sku         text,
  titolo      text,
  quantita    integer     not null default 1,
  prezzo      numeric(12,2),
  image_url   text,
  raw         jsonb       not null default '{}'::jsonb,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

-- ATTENZIONE: "case" è parola riservata in SQL: va SEMPRE virgolettata.
create table if not exists "case" (
  id           uuid primary key default gen_random_uuid(),
  tipo         text        not null default 'generico'
                 check (tipo in ('generico','reso','garanzia','assistenza')),
  riferimento  text        not null unique,
  stato        text        not null default 'aperto',
  order_id     uuid        references "order"(id) on delete set null,
  customer_id  uuid        references customer(id) on delete set null,
  aperto_il    timestamptz not null default now(),
  chiuso_il    timestamptz,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);

create table if not exists thread (
  id                  uuid primary key default gen_random_uuid(),
  account_id          uuid        not null references channel_account(id) on delete cascade,
  external_thread_id  text,
  case_id             uuid        references "case"(id) on delete set null,
  order_id            uuid        references "order"(id) on delete set null,
  identity_id         uuid        references channel_identity(id) on delete set null,
  subject             text,
  state               text        not null default 'new'
                        check (state in ('new','open','pending_customer',
                                         'pending_internal','unmatched','closed')),
  assignee_id         uuid        references agent(id) on delete set null,
  first_inbound_at    timestamptz,
  last_inbound_at     timestamptz,
  due_at              timestamptz,
  tags                text[]      not null default '{}'::text[],
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now()
);

create table if not exists message (
  id              uuid primary key default gen_random_uuid(),
  thread_id       uuid        not null references thread(id) on delete cascade,
  direction       text        not null check (direction in ('in','out')),
  author_kind     text        not null check (author_kind in ('customer','agent','ai','system')),
  external_id     text,
  rfc822_id       text,
  in_reply_to     text,
  body_text       text,
  body_html       text,
  sent_at         timestamptz not null default now(),
  delivery_state  text,
  match_strategy  text,
  raw             jsonb       not null default '{}'::jsonb,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  constraint message_thread_external_key unique (thread_id, external_id)
);

create table if not exists attachment (
  id               uuid primary key default gen_random_uuid(),
  message_id       uuid        not null references message(id) on delete cascade,
  direzione        text        check (direzione in ('in','out')),
  nome_file        text,
  mime             text,
  dimensione_byte  bigint,
  storage_path     text,
  checksum         text,
  tipo             text,
  convertito_da    text,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now()
);

create table if not exists template (
  id               uuid primary key default gen_random_uuid(),
  name             text        not null,
  locale           text        not null default 'it',
  allowed_kinds    text[]      not null default '{}'::text[],
  subject_tpl      text,
  body_tpl         text,
  requires_review  boolean     not null default false,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now()
);

create table if not exists ai_draft (
  id              uuid primary key default gen_random_uuid(),
  thread_id       uuid        not null references thread(id) on delete cascade,
  model           text,
  prompt_version  text,
  draft_text      text,
  policy_check    jsonb       not null default '{}'::jsonb,
  outcome         text,
  final_text      text,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);

create table if not exists sync_state (
  account_id            uuid primary key references channel_account(id) on delete cascade,
  api_cursor            text,
  imap_uid              bigint,
  last_ok_at            timestamptz,
  last_error            text,
  consecutive_failures  integer     not null default 0,
  created_at            timestamptz not null default now(),
  updated_at            timestamptz not null default now()
);

create table if not exists ingest_anomaly (
  id          uuid primary key default gen_random_uuid(),
  account_id  uuid        references channel_account(id) on delete cascade,
  tipo        text        not null,
  payload     jsonb       not null default '{}'::jsonb,
  risolto     boolean     not null default false,
  creata_il   timestamptz not null default now(),
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

create table if not exists audit_log (
  id         uuid primary key default gen_random_uuid(),
  agent_id   uuid        references agent(id) on delete set null,
  azione     text        not null,
  entita     text,
  entita_id  uuid,
  dati       jsonb       not null default '{}'::jsonb,
  creato_il  timestamptz not null default now()
);

-- =====================================================================
-- 2. VINCOLI DI UNICITÀ PARZIALI
-- Sono la difesa contro i duplicati. Non rimuoverli.
-- =====================================================================

-- La stessa email non può diventare due messaggi.
create unique index if not exists message_rfc822_key
  on message (rfc822_id) where rfc822_id is not null;

-- Lo stesso thread di marketplace non può essere importato due volte.
create unique index if not exists thread_account_external_key
  on thread (account_id, external_thread_id) where external_thread_id is not null;

-- =====================================================================
-- 3. INDICI DI PRESTAZIONE
-- =====================================================================

create index if not exists thread_state_due_idx        on thread (state, due_at);
create index if not exists thread_due_idx              on thread (due_at);
create index if not exists message_thread_sent_idx     on message (thread_id, sent_at);
create index if not exists order_channel_external_idx  on "order" (channel, external_order_id);
create index if not exists order_shopify_name_idx      on "order" (shopify_name);
create index if not exists order_buyer_alias_idx       on "order" (buyer_alias);
create index if not exists order_line_order_idx        on order_line (order_id);
create index if not exists attachment_message_idx      on attachment (message_id);
create index if not exists ai_draft_thread_idx         on ai_draft (thread_id);
create index if not exists case_riferimento_idx        on "case" (riferimento);
create index if not exists ingest_anomaly_account_idx  on ingest_anomaly (account_id, risolto);
create index if not exists audit_log_creato_idx        on audit_log (creato_il desc);

-- =====================================================================
-- 4. ROW LEVEL SECURITY
--
-- Modello: solo chi ha una riga attiva in `agent` collegata al proprio
-- account di autenticazione può leggere e scrivere. Nessun accesso
-- anonimo, mai.
-- La service_role usata dal worker bypassa RLS per definizione.
-- =====================================================================

-- Funzione di appoggio. SECURITY DEFINER per evitare la ricorsione
-- delle policy su `agent` quando la si interroga da dentro una policy.
create or replace function public.is_agent()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1 from public.agent
    where user_id = auth.uid() and active
  );
$$;

create or replace function public.is_admin()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1 from public.agent
    where user_id = auth.uid() and active and ruolo = 'admin'
  );
$$;

do $$
declare
  t text;
  tabelle text[] := array[
    'app_config','agent','channel_account','channel_identity','customer',
    'order','order_line','case','thread','message','attachment',
    'template','ai_draft','sync_state','ingest_anomaly','audit_log'
  ];
begin
  foreach t in array tabelle loop
    execute format('alter table public.%I enable row level security', t);

    -- ripulisce eventuali policy omonime, così lo script è rieseguibile
    execute format('drop policy if exists %I on public.%I', t || '_agent_select', t);
    execute format('drop policy if exists %I on public.%I', t || '_agent_write',  t);

    execute format(
      'create policy %I on public.%I for select to authenticated using (public.is_agent())',
      t || '_agent_select', t);

    execute format(
      'create policy %I on public.%I for all to authenticated using (public.is_agent()) with check (public.is_agent())',
      t || '_agent_write', t);
  end loop;
end $$;

-- Eccezione: la configurazione la modifica solo un admin.
drop policy if exists app_config_agent_write on public.app_config;
create policy app_config_admin_write on public.app_config
  for all to authenticated
  using (public.is_admin()) with check (public.is_admin());

-- Eccezione: il registro di audit non si modifica né si cancella.
drop policy if exists audit_log_agent_write on public.audit_log;

-- =====================================================================
-- 5. DATI DI PARTENZA
-- =====================================================================

insert into app_config (key, value) values
  ('installazione', '{"nome":"Hub Messaggi","locale":"it","timezone":"Europe/Rome"}'::jsonb),
  ('colori',        '{"accent":"#12706B"}'::jsonb),
  ('firma_risposte','{"testo":"Il servizio clienti"}'::jsonb),
  ('sla',           '{"default_minuti":1440,"amazon_minuti":1440}'::jsonb),
  ('testi_sistema', '{}'::jsonb)
on conflict (key) do nothing;

-- Canali di esempio. I secret_ref e la config vanno compilati a mano:
-- deep_link è il modello di URL verso la piattaforma d'origine, usato
-- dal pannello contesto per rendere cliccabile il numero d'ordine.
insert into channel_account (kind, code, display_name, locale, transport, config) values
  ('amazon',  'amazon-it',    'Amazon.it',           'it', 'imap',
   '{"deep_link":"https://sellercentral.amazon.it/orders-v3/order/{id}"}'::jsonb),
  ('mirakl',  'mirakl-mms',   'MediaMarktSaturn',    'it', 'api',
   '{"endpoint":"","deep_link":""}'::jsonb),
  ('mirakl',  'mirakl-lmfr',  'Leroy Merlin France', 'fr', 'api',
   '{"endpoint":"","deep_link":""}'::jsonb),
  ('shopify', 'shopify-web',  'Sito',                'it', 'api',
   '{"deep_link":"https://admin.shopify.com/store/{shop}/orders/{id}"}'::jsonb)
on conflict (code) do nothing;

-- =====================================================================
-- 6. VERIFICA
-- Deve restituire 5 righe: i cinque vincoli che tengono fuori i duplicati.
-- =====================================================================

select indexname from pg_indexes
where schemaname = 'public' and indexname in (
  'order_channel_external_key',
  'message_thread_external_key',
  'message_rfc822_key',
  'thread_account_external_key',
  'channel_identity_account_external_key'
)
order by indexname;
