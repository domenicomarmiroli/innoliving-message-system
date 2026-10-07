-- 0041 — Indirizzo del portale garanzie per brand, per l'email che
-- l'assistente vocale fa partire dopo una telefonata per un prodotto in
-- garanzia (connectors/voce/garanzia.ts). Dati, non codice.
--
-- Bimar: nessun portale, il cliente passa dal centro assistenza.
-- HIGO: il portale non ha ancora un dominio suo: da aggiungere quando c'è,
--   con lo stesso update.
-- Solo dati. Rieseguibile.

update channel_account set config = config || jsonb_build_object('portale_url', v.url, 'marchio', v.marchio)
from (values
  ('garanzia-innoliving', 'https://garanzia.innoliving.it/', 'Innoliving'),
  ('garanzia-viceversa',  'https://garanzia.viceversa.it/',  'Viceversa'),
  ('garanzia-medifit',    'https://garanzia.medifit.it/',    'Medifit')
) as v(code, url, marchio)
where channel_account.code = v.code;

update channel_account set config = config || '{"marchio": "Bimar"}'::jsonb where code = 'garanzia-bimar';
update channel_account set config = config || '{"marchio": "HIGO"}'::jsonb where code = 'garanzia-higo';

select code, config->>'portale_url' as portale, config->>'marchio' as marchio
from channel_account where code like 'garanzia-%' order by code;
