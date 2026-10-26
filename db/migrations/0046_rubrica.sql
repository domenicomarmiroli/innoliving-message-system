-- Rubrica dei destinatari dei ticket collegati (magazzino, corriere,
-- assistenza...). Dato interno: Lovable la legge e la scrive direttamente,
-- come tag e note. Il worker non la usa: /threads/collega riceve sempre
-- l'indirizzo già scelto.
-- Si disattiva (attivo = false), non si cancella: un contatto può essere già
-- stato usato in ticket passati.

create table if not exists rubrica_contatto (
  id          uuid primary key default gen_random_uuid(),
  nome        text not null,
  email       text not null,
  -- stessi valori del campo "Tipo" del modulo: corriere | assistenza | altro
  tipo        text not null default 'altro' check (tipo in ('corriere', 'assistenza', 'altro')),
  note        text,
  attivo      boolean not null default true,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

create unique index if not exists rubrica_contatto_email_key on rubrica_contatto (lower(email));

alter table rubrica_contatto enable row level security;
drop policy if exists rubrica_contatto_agent_all on rubrica_contatto;
create policy rubrica_contatto_agent_all on rubrica_contatto
  for all to authenticated using (public.is_agent()) with check (public.is_agent());
