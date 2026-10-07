-- =====================================================================
-- Hub Messaggi — migrazione 0040: misura e tetto di spesa delle chiamate AI
--
-- Nata da un caso reale (02-07/10): la traduzione in arrivo ritraduceva a
-- ogni giro quattro newsletter troppo lunghe (risposta troncata, mai
-- salvata, ripagata ogni due minuti e mezzo) e lo si è scoperto solo dal
-- conto della console Anthropic.
--
--   ai_uso         una riga per ogni chiamata AI del worker: funzione,
--                  modello, token, costo stimato, risposta troncata.
--                  Leggibile dagli operatori (dashboard).
--   ai_controllo   (app_config) tetto giornaliero in dollari per i lavori
--                  in background (traduzione in arrivo, classificazione) e
--                  prezzi per modello. Superato il tetto quei giri si
--                  fermano fino a mezzanotte e compare un'anomalia
--                  `ai_budget_superato`. Bozze e traduzioni chieste dagli
--                  operatori non si bloccano.
--
-- Prezzi Anthropic al 25/09/2026, dollari per milione di token. Da
-- aggiornare qui se cambiano: un modello non elencato viene stimato a
-- 5/25, apposta più caro del vero.
--
-- Da eseguire nell'editor SQL di Supabase PRIMA del deploy del worker che
-- scrive in ai_uso (senza la tabella la registrazione fallisce in un
-- avviso di log, le chiamate funzionano lo stesso). È idempotente.
-- =====================================================================

create table if not exists ai_uso (
  id          bigint generated always as identity primary key,
  created_at  timestamptz not null default now(),
  funzione    text        not null,
  modello     text        not null,
  token_in    integer     not null default 0,
  token_out   integer     not null default 0,
  costo_usd   numeric(12,6) not null default 0,
  troncata    boolean     not null default false
);

create index if not exists ai_uso_created_idx on ai_uso (created_at desc);

alter table ai_uso enable row level security;
drop policy if exists ai_uso_agent_select on ai_uso;
create policy ai_uso_agent_select on ai_uso for select to authenticated using (public.is_agent());

insert into app_config (key, value)
values (
  'ai_controllo',
  '{
    "budget_giornaliero_usd": 5,
    "prezzi": {
      "claude-haiku-4-5": { "input": 1, "output": 5 },
      "claude-sonnet-5":  { "input": 2, "output": 10 },
      "claude-sonnet-5-5": { "input": 2, "output": 10 },
      "claude-opus-5-5":  { "input": 4, "output": 20 }
    }
  }'::jsonb
)
on conflict (key) do nothing;

-- Vista per la dashboard: spesa per giorno (ora italiana) e funzione.
create or replace view v_ai_uso_giornaliero
with (security_invoker = true) as
select
  (created_at at time zone 'Europe/Rome')::date as giorno,
  funzione,
  count(*)                       as chiamate,
  sum(token_in)                  as token_in,
  sum(token_out)                 as token_out,
  round(sum(costo_usd), 4)       as costo_usd,
  count(*) filter (where troncata) as troncate
from ai_uso
group by 1, 2;

-- Verifica
select key, value->>'budget_giornaliero_usd' as tetto from app_config where key = 'ai_controllo';
