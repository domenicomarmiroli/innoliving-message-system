-- =====================================================================
-- Hub Messaggi — migrazione 0015: viste per la dashboard di reportistica
--
-- Quattro viste, ciascuna per un calcolo che PostgREST/Supabase non può
-- fare da solo (join laterali, unnest): il resto della dashboard (ticket
-- al giorno per canale, utilizzo AI aggregato) si legge con select
-- dirette su thread/channel_account/ai_draft, senza bisogno di nuove
-- viste.
--
-- `security_invoker = true` su tutte: senza, una vista gira con i
-- permessi di chi l'ha creata e bypasserebbe la row-level security
-- delle tabelle sottostanti per chiunque la interroghi — l'opposto di
-- quello che vogliamo. Con questa opzione, valgono le stesse policy che
-- varrebbero interrogando thread/message direttamente: se un agente può
-- già leggere la coda, può leggere queste viste.
--
-- Da eseguire nell'editor SQL di Supabase dopo la 0014 (le viste usano
-- message.agent_id e message.draft_id). È idempotente (create or replace).
-- =====================================================================

-- ---------------------------------------------------------------------
-- 1. Una riga per thread: tempo alla prima risposta e rispetto SLA.
-- ---------------------------------------------------------------------
create or replace view v_thread_metriche
with (security_invoker = true) as
select
  t.id                as thread_id,
  t.account_id,
  ca.kind             as channel_kind,
  ca.code             as channel_code,
  ca.display_name     as channel_display_name,
  ca.sla_minutes,
  t.assignee_id,
  ag.nome             as agente_nome,
  t.state,
  t.tags,
  t.created_at,
  t.first_inbound_at,
  t.last_inbound_at,
  prima.sent_at       as prima_risposta_at,
  case when prima.sent_at is not null and t.first_inbound_at is not null
       then extract(epoch from (prima.sent_at - t.first_inbound_at)) / 60.0
  end                 as minuti_prima_risposta,
  case when prima.sent_at is not null and t.first_inbound_at is not null
       then (extract(epoch from (prima.sent_at - t.first_inbound_at)) / 60.0) <= ca.sla_minutes
  end                 as entro_sla
from thread t
join channel_account ca on ca.id = t.account_id
left join agent ag on ag.id = t.assignee_id
left join lateral (
  select m.sent_at
  from message m
  where m.thread_id = t.id
    and m.direction = 'out'
    and m.author_kind = 'agent'
    and not m.interno
    and (t.first_inbound_at is null or m.sent_at >= t.first_inbound_at)
  order by m.sent_at asc
  limit 1
) prima on true;

-- ---------------------------------------------------------------------
-- 2. Una riga per ogni messaggio in arrivo abbinato alla risposta
--    successiva: serve al tempo di risposta medio "generale" (non solo
--    la prima) e alle statistiche per agente (porta agent_id).
-- ---------------------------------------------------------------------
create or replace view v_tempi_risposta
with (security_invoker = true) as
select
  m_in.thread_id,
  m_in.id                                                    as message_in_id,
  m_in.sent_at                                                as ricevuto_il,
  m_out.id                                                    as message_out_id,
  m_out.sent_at                                                as risposto_il,
  m_out.agent_id,
  extract(epoch from (m_out.sent_at - m_in.sent_at)) / 60.0    as minuti_risposta
from message m_in
join lateral (
  select mo.id, mo.sent_at, mo.agent_id
  from message mo
  where mo.thread_id = m_in.thread_id
    and mo.direction = 'out'
    and mo.author_kind = 'agent'
    and not mo.interno
    and mo.sent_at > m_in.sent_at
  order by mo.sent_at asc
  limit 1
) m_out on true
where m_in.direction = 'in' and not m_in.interno;

-- ---------------------------------------------------------------------
-- 3. Tag "srotolati" un rigo per tag: la scomposizione per tipologia
--    (RESO, DANNO, RECESSO, RIMBORSO, TRACKING...) non è altro che un
--    conteggio su questa vista filtrato per data/canale.
-- ---------------------------------------------------------------------
create or replace view v_tag_giornalieri
with (security_invoker = true) as
select
  t.id        as thread_id,
  t.account_id,
  ca.kind     as channel_kind,
  t.created_at,
  tag
from thread t
join channel_account ca on ca.id = t.account_id
cross join lateral unnest(t.tags) as tag
where array_length(t.tags, 1) > 0;

-- ---------------------------------------------------------------------
-- 4. Bozze AI davvero spedite, con chi le ha spedite: message.draft_id
--    (migrazione 0014) collegato ad ai_draft.outcome.
-- ---------------------------------------------------------------------
create or replace view v_bozze_utilizzo
with (security_invoker = true) as
select
  m.id            as message_id,
  m.thread_id,
  m.agent_id,
  m.sent_at,
  d.id            as draft_id,
  d.model,
  d.outcome,
  d.created_at    as bozza_creata_il
from message m
join ai_draft d on d.id = m.draft_id
where m.draft_id is not null;

grant select on v_thread_metriche, v_tempi_risposta, v_tag_giornalieri, v_bozze_utilizzo to authenticated;

-- ---------------------------------------------------------------------
-- Verifica
-- ---------------------------------------------------------------------
select count(*) from v_thread_metriche;
select count(*) from v_tempi_risposta;
select count(*) from v_tag_giornalieri;
select count(*) from v_bozze_utilizzo;

-- =====================================================================
-- NOTA PER CHI TOCCA LOVABLE — la dashboard
--
-- Ticket al giorno (totale e per canale) e utilizzo AI aggregato NON
-- servono una vista: si leggono con select dirette su
-- thread(id,account_id,created_at) con channel_account(kind,
-- display_name) annidato, e su ai_draft(id,model,outcome,created_at) —
-- stesso pattern già in uso altrove in Lovable.
--
-- ai_draft probabilmente non ha ancora una policy SELECT per gli agenti
-- autenticati: finora la bozza arrivava dalla risposta HTTP del worker,
-- mai da una lettura diretta. Se la dashboard la richiede e la query
-- torna vuota o in errore, è quello — mandate la policy, non
-- indovinatela qui.
-- =====================================================================
