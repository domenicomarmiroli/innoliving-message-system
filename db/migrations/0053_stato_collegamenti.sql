-- =====================================================================
-- Hub Messaggi — migrazione 0053: stato dei collegamenti esterni.
--
-- Ogni giro del worker (casella Microsoft, Gmail, Mirakl, Shopify, BRT,
-- magazzino) e ogni invio (Microsoft, Gmail, Mirakl) aggiornano qui una
-- riga: ultimo successo, ultimo errore, errori di fila. L'interfaccia
-- legge la tabella (RLS, solo lettura per gli agenti) e mostra un avviso
-- quando ultimo_errore_at è più recente di ultimo_ok_at.
--
-- Nata dal ticket 16121 (13/11): Outlook giù, la risposta non partiva e
-- nessuno lo vedeva. Scrive solo il worker (bypassa RLS). Prima di questa
-- migrazione il worker gira lo stesso: la scrittura dello stato è best
-- effort e ignora la tabella mancante.
--
-- Da eseguire nell'editor SQL di Supabase. Idempotente.
-- =====================================================================

create table if not exists stato_collegamento (
  codice             text primary key,
  nome               text not null,
  ultimo_ok_at       timestamptz,
  ultimo_errore_at   timestamptz,
  ultimo_errore      text,
  errori_consecutivi integer not null default 0,
  dettaglio          text,
  aggiornato_at      timestamptz not null default now()
);

alter table stato_collegamento enable row level security;

drop policy if exists stato_collegamento_agent_select on stato_collegamento;
create policy stato_collegamento_agent_select on stato_collegamento
  for select to authenticated using (public.is_agent());

-- Verifica (vuota finché il worker non fa il primo giro dopo il deploy)
select codice, ultimo_ok_at, ultimo_errore_at, ultimo_errore from stato_collegamento order by codice;
