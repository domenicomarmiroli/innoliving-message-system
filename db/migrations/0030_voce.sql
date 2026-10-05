-- =====================================================================
-- Hub Messaggi — migrazione 0030: canale voce (agente ElevenLabs)
--
-- Tre tabelle di servizio per l'agente vocale, che chiama il worker
-- (rotte /voce/*) per leggere i dati dell'ordine e aprire ticket:
--
--   voice_session  l'ordine verificato durante una telefonata. Dopo la
--                  verifica (numero d'ordine + email o CAP) l'agente
--                  riceve un token valido 30 minuti e da lì in avanti può
--                  chiedere solo di QUELL'ordine. Si salva l'impronta
--                  del token, mai il token: chi legge la tabella non può
--                  riusarlo.
--   voice_log      una riga per ogni chiamata a una rotta /voce/*,
--                  rifiutate comprese: strumento, esito, latenza e la
--                  richiesta con i dati personali già oscurati.
--   voice_call     una riga per telefonata, dal webhook di fine chiamata
--                  (fase 5): riassunto, esito, ticket aperto. Il numero
--                  del chiamante solo come impronta.
--
-- RLS attiva e nessuna policy: per ora le legge solo il worker (che
-- bypassa RLS). Se l'interfaccia dovrà mostrarle, si aggiunge una policy
-- di sola lettura con una migrazione dedicata.
--
-- Da eseguire nell'editor SQL di Supabase dopo la 0029. È idempotente.
-- =====================================================================

create table if not exists voice_session (
  id               uuid primary key default gen_random_uuid(),
  conversation_id  text        not null,
  token_hash       text        not null unique,
  order_id         uuid        not null references "order"(id) on delete cascade,
  verified_at      timestamptz not null default now(),
  expires_at       timestamptz not null,
  created_at       timestamptz not null default now()
);
create index if not exists voice_session_conversation_idx on voice_session (conversation_id);

create table if not exists voice_log (
  id                 uuid primary key default gen_random_uuid(),
  conversation_id    text,
  tool               text        not null,
  request_sanitized  jsonb,
  response_status    integer     not null,
  -- Esito di dominio, quando c'è ('verificato', 'ordine_non_trovato'...):
  -- serve a contare i tentativi di verifica e ai KPI del pilota.
  esito              text,
  latency_ms         integer,
  created_at         timestamptz not null default now()
);
create index if not exists voice_log_conversation_idx on voice_log (conversation_id, created_at);
create index if not exists voice_log_created_idx on voice_log (created_at desc);

create table if not exists voice_call (
  conversation_id     text primary key,
  agent_ref           text,
  caller_number_hash  text,
  brand               text,
  summary             text,
  transcript_ref      text,
  outcome             text,
  dati_raccolti       jsonb,
  thread_id           uuid        references thread(id) on delete set null,
  -- Regola 4: il payload originale del webhook, integrale.
  raw                 jsonb       not null default '{}'::jsonb,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now()
);
create index if not exists voice_call_thread_idx on voice_call (thread_id) where thread_id is not null;

alter table voice_session enable row level security;
alter table voice_log     enable row level security;
alter table voice_call    enable row level security;

-- ---------------------------------------------------------------------
-- Verifica: tre righe, tutte con rowsecurity = true
-- ---------------------------------------------------------------------
select tablename, rowsecurity
from pg_tables
where schemaname = 'public' and tablename in ('voice_session', 'voice_log', 'voice_call');
