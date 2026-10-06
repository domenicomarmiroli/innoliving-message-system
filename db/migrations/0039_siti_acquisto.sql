-- =====================================================================
-- Hub Messaggi — migrazione 0039: dove acquistare, per marchio
--
-- Solo dati. Quando un cliente al telefono chiede dove comprare un
-- prodotto, l'agente vocale deve indicare il sito del marchio e SEMPRE
-- l'outlet che ha tutti i prodotti. Il worker aggiunge questi siti alla
-- scheda prodotto (`dove_acquistare`): affidare l'abbinamento
-- marchio→sito al prompt dell'agente si è dimostrato fragile (06/10, un
-- prodotto Bimar indirizzato al sito di un altro marchio).
--
-- Regola 7: i siti stanno qui, non nel codice. Si cambiano con un UPDATE.
--   per_marchio: etichetta del marchio come nel PIM (brands.label) → sito
--   sempre:      il sito da indicare per ogni prodotto
--   pronuncia:   come l'agente deve dire un sito al telefono
--
-- Da eseguire nell'editor SQL di Supabase dopo la 0038. È idempotente.
-- =====================================================================

insert into app_config (key, value)
values (
  'voce_siti_acquisto',
  '{
    "per_marchio": {
      "Bimar": "bimaritaly.it",
      "Innoliving": "innoliving.it",
      "Viceversa": "viceversa.it"
    },
    "sempre": "inshopping.it",
    "pronuncia": {
      "bimaritaly.it": "bimar italy punto it",
      "innoliving.it": "innoliving punto it",
      "viceversa.it": "viceversa punto it",
      "inshopping.it": "in shopping punto it"
    }
  }'::jsonb
)
on conflict (key) do update set value = excluded.value, updated_at = now();

-- Verifica: una riga
select key, value from app_config where key = 'voce_siti_acquisto';
