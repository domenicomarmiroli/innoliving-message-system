-- 0036 — Trascrizione delle telefonate dell'agente vocale (fase 5).
--
-- Il webhook di fine chiamata di ElevenLabs (routes/voce-webhook.ts)
-- salva qui la trascrizione, collegata al ticket della telefonata.
-- L'interfaccia la mostra in un popup dal ticket: per questo gli
-- operatori ora possono LEGGERE voice_call (solo lettura, come le altre
-- tabelle con is_agent()). voice_session e voice_log restano senza policy.

alter table voice_call
  -- [{ruolo: 'agente'|'cliente', testo, secondo}], in ordine.
  add column if not exists trascrizione   jsonb,
  add column if not exists durata_secondi integer,
  add column if not exists iniziata_at    timestamptz;

drop policy if exists voice_call_agent_read on public.voice_call;
create policy voice_call_agent_read on public.voice_call
  for select to authenticated using (public.is_agent());
