-- =====================================================================
-- Hub Messaggi, migrazione 0058: richiesta al centro assistenza esterno.
--
-- Chiesto da Domenico il 2026-11-26. Dal ticket di garanzia un pulsante
-- manda al centro assistenza partner (casella collegata al suo Zendesk) una
-- mail con oggetto "RICHIESTA PORTALE GARANZIA <Nome Cliente>" e tutti i
-- dati della pratica in righe fisse, che il partner legge in automatico.
-- Parte come ticket collegato: la risposta del partner torna nell'Hub.
--
-- app_config.assistenza_partner: indirizzo, prefisso dell'oggetto, nome.
-- Niente tabelle nuove. Da eseguire PRIMA del deploy. Idempotente.
-- =====================================================================

insert into app_config (key, value) values (
  'assistenza_partner',
  '{
     "email": "innoliving@ggfgroup.it",
     "prefisso_oggetto": "RICHIESTA PORTALE GARANZIA",
     "nome": "Centro assistenza GGF"
   }'::jsonb
)
on conflict (key) do nothing;

select key, value from app_config where key = 'assistenza_partner';
