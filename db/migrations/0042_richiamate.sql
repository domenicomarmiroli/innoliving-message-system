-- =====================================================================
-- Hub Messaggi — migrazione 0042: richiamata del cliente con l'agente vocale
--
-- L'operatore, da un ticket, fa partire una telefonata al cliente: l'agente
-- vocale (ElevenLabs, chiamata in uscita via trunk SIP) gli riferisce il
-- messaggio scritto dall'operatore e ne raccoglie le risposte. Se il
-- cliente non risponde si riprova durante la giornata, ogni 1-2 ore, solo
-- fra le 8:00 e le 21:00 (ora italiana).
--
--   richiamata            una richiesta dell'operatore: numero, messaggio,
--                         stato, prossimo tentativo.
--   richiamata_tentativo  ogni telefonata fatta: il conversation_id di
--                         ElevenLabs collega l'esito (webhook di fine
--                         chiamata) alla richiamata giusta.
--   voce_richiamate       (app_config) fascia oraria, attese, tentativi.
--
-- Gli operatori leggono entrambe le tabelle (RLS); le scrive solo il
-- worker (rotte /threads/richiama).
--
-- Da eseguire nell'editor SQL di Supabase PRIMA del deploy del worker
-- che le usa. È idempotente.
-- =====================================================================

create table if not exists richiamata (
  id                     uuid primary key default gen_random_uuid(),
  thread_id              uuid not null references thread(id) on delete cascade,
  numero                 text not null,
  messaggio              text not null,
  stato                  text not null default 'in_attesa'
                           check (stato in ('in_attesa', 'in_corso', 'completata', 'non_raggiunto', 'annullata')),
  tentativi              integer not null default 0,
  prossimo_tentativo_at  timestamptz,
  ultimo_esito           text,
  creata_da              uuid references agent(id) on delete set null,
  created_at             timestamptz not null default now(),
  updated_at             timestamptz not null default now(),
  conclusa_at            timestamptz
);

create index if not exists richiamata_da_fare_idx
  on richiamata (prossimo_tentativo_at) where stato = 'in_attesa';
create index if not exists richiamata_thread_idx on richiamata (thread_id, created_at desc);

create table if not exists richiamata_tentativo (
  id               uuid primary key default gen_random_uuid(),
  richiamata_id    uuid not null references richiamata(id) on delete cascade,
  conversation_id  text unique,
  avviato_at       timestamptz not null default now(),
  esito            text,
  concluso_at      timestamptz
);
create index if not exists richiamata_tentativo_idx on richiamata_tentativo (richiamata_id, avviato_at);

alter table richiamata enable row level security;
alter table richiamata_tentativo enable row level security;
drop policy if exists richiamata_agent_select on richiamata;
create policy richiamata_agent_select on richiamata for select to authenticated using (public.is_agent());
drop policy if exists richiamata_tentativo_agent_select on richiamata_tentativo;
create policy richiamata_tentativo_agent_select on richiamata_tentativo for select to authenticated using (public.is_agent());

insert into app_config (key, value)
values (
  'voce_richiamate',
  '{
    "ora_inizio": "08:00",
    "ora_fine": "21:00",
    "attesa_min_minuti": 60,
    "attesa_max_minuti": 120,
    "max_tentativi": 5,
    "margine_fine_minuti": 10
  }'::jsonb
)
on conflict (key) do nothing;

-- Verifica
select
  (select count(*) from pg_tables where tablename in ('richiamata', 'richiamata_tentativo')) as tabelle,
  (select value->>'ora_inizio' || '-' || (value->>'ora_fine') from app_config where key = 'voce_richiamate') as fascia;
