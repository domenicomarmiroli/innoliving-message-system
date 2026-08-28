-- =====================================================================
-- Hub Messaggi — migrazione 0022: distinguere i messaggi-evento per la
-- reportistica (resi e rimborsi nel tempo)
--
-- Il problema: resi.ts e rimborsi.ts inseriscono un messaggio di sistema
-- (author_kind='system', match_strategy='numero_ordine') per annotare la
-- conversazione — ma la STESSA forma la usano anche gli avvisi
-- (registraAvviso in notifica.ts). Non c'era modo di distinguere, dalla
-- tabella message, "questo è un reso" da "questo è un rimborso" da "è un
-- avviso qualunque" — necessario per contare resi e rimborsi giorno per
-- giorno in un grafico, cosa che serve ORA (richiesta di Domenico).
--
-- v_tag_giornalieri (migrazione 0015) non basta: è per thread, datata su
-- thread.created_at (quando il thread è nato, non quando l'evento
-- specifico è successo) — un thread può avere sia "reso-richiesto" sia
-- "rimborso-emesso" nel tempo, e un tag non conta le occorrenze
-- ripetute. Serve il livello del singolo messaggio/evento, con la sua
-- data vera (message.sent_at).
--
-- message.tipo_evento: discriminatore libero (come delivery_state),
-- oggi valorizzato solo per 'reso_richiesto' e 'rimborso_emesso'; null
-- per ogni messaggio normale (cliente, agente, bozza).
-- message.importo / message.importo_valuta: l'importo DI QUESTO evento
-- (non cumulativo, a differenza di order.rimborso_totale) — per sommare
-- per giorno nel grafico. Valuta letta dall'email, non assunta: un
-- marketplace non-euro non deve essere sommato come se lo fosse.
--
-- Da eseguire dopo la 0021. È idempotente.
-- =====================================================================

alter table message
  add column if not exists tipo_evento     text,
  add column if not exists importo         numeric(12,2),
  add column if not exists importo_valuta  text;

comment on column message.tipo_evento is
  'Discriminatore per i messaggi generati dal sistema: reso_richiesto, rimborso_emesso. Null per i messaggi normali.';
comment on column message.importo is
  'Importo di QUESTO evento (es. un singolo rimborso), non cumulativo. Vedi order.rimborso_totale per il cumulativo sull''ordine.';
comment on column message.importo_valuta is
  'Valuta di message.importo, letta dall''email — mai assunta.';

create index if not exists message_tipo_evento_idx
  on message (tipo_evento, sent_at) where tipo_evento is not null;
