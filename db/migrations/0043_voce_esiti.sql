-- =====================================================================
-- Hub Messaggi — migrazione 0043: esito di ogni telefonata, per la dashboard
--
-- Richiesta di Domenico (08/10): monitorare TUTTE le chiamate, non solo
-- quelle che aprono un ticket, e sapere quante sono risolutive, cioè il
-- cliente ha avuto la risposta senza bisogno di un ticket.
--
-- `voice_call` riceve già ogni chiamata dal webhook di fine chiamata. La
-- valutazione di ElevenLabs (raccolta dati `problema_risolto`,
-- `necessario_escalation`, `tipo_richiesta`; criterio `richiesta_risolta`)
-- sta nel payload grezzo: la vista la legge da lì, nessun dato da
-- ricalcolare e vale anche per le chiamate già registrate.
--
-- esito, in quest'ordine:
--   richiamata   chiamata in uscita del sistema delle richiamate
--   interrotta   meno di 15 secondi o il cliente non ha mai parlato
--   ticket       l'agente ha aperto un ticket
--   risolta      nessun ticket e ElevenLabs la valuta risolta, senza
--                escalation
--   non_risolta  nessun ticket e non risolta: il cliente è rimasto senza
--                risposta. È la riga da guardare.
--
-- Solo vista, nessuna tabella toccata. Idempotente.
-- =====================================================================

create or replace view v_voce_chiamate
with (security_invoker = true) as
with base as (
  select
    v.conversation_id,
    coalesce(v.iniziata_at, v.created_at)                            as iniziata_at,
    (coalesce(v.iniziata_at, v.created_at) at time zone 'Europe/Rome')::date as giorno,
    v.brand,
    v.durata_secondi,
    v.verificato,
    v.ticket_aperto,
    v.thread_id,
    v.chiamata_test,
    v.costo_usd,
    v.costo_crediti,
    exists (select 1 from richiamata_tentativo rt where rt.conversation_id = v.conversation_id) as richiamata,
    exists (
      select 1 from jsonb_array_elements(coalesce(v.trascrizione, '[]'::jsonb)) t
      where t->>'ruolo' = 'cliente' and length(trim(coalesce(t->>'testo', ''))) > 0
    ) as cliente_ha_parlato,
    v.raw->'data'->'analysis'->'data_collection_results'->'tipo_richiesta'->>'value'        as tipo_richiesta,
    (v.raw->'data'->'analysis'->'data_collection_results'->'problema_risolto'->>'value')::text      as problema_risolto,
    (v.raw->'data'->'analysis'->'data_collection_results'->'necessario_escalation'->>'value')::text as necessario_escalation,
    v.raw->'data'->'analysis'->'evaluation_criteria_results'->'richiesta_risolta'->>'result'       as richiesta_risolta,
    v.raw->'data'->'analysis'->'evaluation_criteria_results'->'soddisfazione_cliente'->>'result'   as soddisfazione_cliente
  from voice_call v
)
select
  b.*,
  case
    when b.richiamata then 'richiamata'
    when coalesce(b.durata_secondi, 0) < 15 or not b.cliente_ha_parlato then 'interrotta'
    when b.ticket_aperto then 'ticket'
    when (b.problema_risolto = 'true' or (b.problema_risolto is null and b.richiesta_risolta = 'success'))
         and coalesce(b.necessario_escalation, 'false') <> 'true' then 'risolta'
    else 'non_risolta'
  end as esito
from base b;

-- Riepilogo per giorno, senza le chiamate di prova dal simulatore.
-- tasso_risoluzione = risolte / (risolte + ticket + non risolte): le
-- interrotte e le richiamate non sono richieste a cui rispondere.
create or replace view v_voce_giornaliero
with (security_invoker = true) as
select
  giorno,
  count(*) filter (where esito <> 'richiamata')           as chiamate_in_arrivo,
  count(*) filter (where esito = 'risolta')               as risolte,
  count(*) filter (where esito = 'ticket')                as con_ticket,
  count(*) filter (where esito = 'non_risolta')           as non_risolte,
  count(*) filter (where esito = 'interrotta')            as interrotte,
  count(*) filter (where esito = 'richiamata')            as richiamate,
  round(
    100.0 * count(*) filter (where esito = 'risolta')
    / nullif(count(*) filter (where esito in ('risolta', 'ticket', 'non_risolta')), 0), 1
  )                                                       as tasso_risoluzione_pct,
  round(avg(durata_secondi) filter (where esito <> 'interrotta'))::int as durata_media_secondi,
  round(sum(coalesce(costo_usd, 0)), 2)                   as costo_usd
from v_voce_chiamate
where not coalesce(chiamata_test, false)
group by giorno;

-- Verifica
select esito, count(*) from v_voce_chiamate group by esito order by 2 desc;
