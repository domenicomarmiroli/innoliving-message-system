-- =====================================================================
-- Hub Messaggi — schema del database
--
-- COPIA IN SOLA LETTURA. Lo schema è di proprietà del progetto Lovable.
-- Questo file serve a due cose:
--   1. dare a Claude Code la verità su tabelle e vincoli;
--   2. ricreare un'installazione nuova su un database vuoto.
-- Non modificarlo a mano: si rigenera dal database dopo ogni modifica
-- fatta in Lovable (vedi passo 02 del runbook).
--
-- Esportato il 25 agosto 2026 dal progetto 4a499e5f.
-- =====================================================================

create extension if not exists pgcrypto;

-- ---------------------------------------------------------------- config
create table app_config (
  key         text primary key,
  value       jsonb       not null default '{}'::jsonb,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

create table agent (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid unique,
  nome        text        not null,
  email       text,
  ruolo       text        not null default 'agente',
  active      boolean     not null default true,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

-- ---------------------------------------------------------------- canali
create table channel_account (
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

create table customer (
  id          uuid primary key default gen_random_uuid(),
  nome        text,
  email       text,
  telefono    text,
  note        text,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

create table channel_identity (
  id            uuid primary key default gen_random_uuid(),
  account_id    uuid        not null references channel_account(id) on delete cascade,
  external_id   text        not null,
  display_name  text,
  customer_id   uuid        references customer(id) on delete set null,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  constraint channel_identity_account_external_key unique (account_id, external_id)
);

-- ---------------------------------------------------------------- ordini
create table "order" (
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
  -- Spedizione di RESO (dal cliente a noi), da Amazon RETURN_REQUEST:
  -- distinta dalla spedizione in uscita qui sopra.
  reso_carrier          text,
  reso_tracking_number  text,
  total              numeric(12,2),
  currency           text,
  raw                jsonb       not null default '{}'::jsonb,
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now(),
  constraint order_channel_external_key unique (channel, external_order_id)
);

create table order_line (
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

-- ---------------------------------------------------------------- pratiche
-- ATTENZIONE: la tabella si chiama "case", che è parola riservata in SQL.
-- Va SEMPRE virgolettata nelle query scritte a mano.
create table "case" (
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

-- ---------------------------------------------------------------- conversazioni
create table thread (
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

create table message (
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

create table attachment (
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

-- ---------------------------------------------------------------- risposte
create table template (
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

create table ai_draft (
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

-- ---------------------------------------------------------------- esercizio
create table sync_state (
  account_id            uuid primary key references channel_account(id) on delete cascade,
  api_cursor            text,
  imap_uid              bigint,
  last_ok_at            timestamptz,
  last_error            text,
  consecutive_failures  integer     not null default 0,
  created_at            timestamptz not null default now(),
  updated_at            timestamptz not null default now()
);

create table ingest_anomaly (
  id          uuid primary key default gen_random_uuid(),
  account_id  uuid        references channel_account(id) on delete cascade,
  tipo        text        not null,
  payload     jsonb       not null default '{}'::jsonb,
  risolto     boolean     not null default false,
  creata_il   timestamptz not null default now(),
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

create table audit_log (
  id         uuid primary key default gen_random_uuid(),
  agent_id   uuid        references agent(id) on delete set null,
  azione     text        not null,
  entita     text,
  entita_id  uuid,
  dati       jsonb       not null default '{}'::jsonb,
  creato_il  timestamptz not null default now()
);

-- =====================================================================
-- VINCOLI DI UNICITÀ PARZIALI
-- Sono la difesa contro i duplicati. Non rimuoverli.
-- =====================================================================

-- La stessa email non può diventare due messaggi.
create unique index message_rfc822_key
  on message (rfc822_id) where rfc822_id is not null;

-- Lo stesso thread di marketplace non può essere importato due volte.
create unique index thread_account_external_key
  on thread (account_id, external_thread_id) where external_thread_id is not null;

-- =====================================================================
-- INDICI DI PRESTAZIONE
-- =====================================================================

create index thread_state_due_idx        on thread (state, due_at);
create index thread_due_idx              on thread (due_at);
create index message_thread_sent_idx     on message (thread_id, sent_at);
create index order_channel_external_idx  on "order" (channel, external_order_id);
create index order_shopify_name_idx      on "order" (shopify_name);
create index order_buyer_alias_idx       on "order" (buyer_alias);
create index order_line_order_idx        on order_line (order_id);
create index attachment_message_idx      on attachment (message_id);
create index ai_draft_thread_idx         on ai_draft (thread_id);
create index case_riferimento_idx        on "case" (riferimento);
create index ingest_anomaly_account_idx  on ingest_anomaly (account_id, risolto);
create index audit_log_creato_idx        on audit_log (creato_il desc);

-- =====================================================================
-- ROW LEVEL SECURITY
-- Attiva su tutte le tabelle. La service_role del worker la bypassa.
-- Le policy per gli utenti autenticati sono gestite da Lovable.
-- =====================================================================

alter table app_config       enable row level security;
alter table agent            enable row level security;
alter table channel_account  enable row level security;
alter table channel_identity enable row level security;
alter table customer         enable row level security;
alter table "order"          enable row level security;
alter table order_line       enable row level security;
alter table "case"           enable row level security;
alter table thread           enable row level security;
alter table message          enable row level security;
alter table attachment       enable row level security;
alter table template         enable row level security;
alter table ai_draft         enable row level security;
alter table sync_state       enable row level security;
alter table ingest_anomaly   enable row level security;
alter table audit_log        enable row level security;
