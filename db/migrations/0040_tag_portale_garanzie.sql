-- 0040 — I ticket del portale garanzie nascono col tag 'garanzia'.
-- Collaudo 07/10: la classificazione automatica aveva messo 'altro' a una
-- richiesta di riparazione in garanzia. Il canale stesso dice cos'è:
-- `channel_account.config.tag_predefiniti`, letto da routes/contatti.ts.
-- La classificazione resta e AGGIUNGE la sua categoria (fino a 2).
-- Solo dati. Rieseguibile.

update channel_account
set config = jsonb_set(coalesce(config, '{}'::jsonb), '{tag_predefiniti}', '["garanzia"]'::jsonb)
where code like 'garanzia-%';

-- I ticket già aperti dal portale prendono il tag, senza perdere gli altri.
update thread t
set tags = (select array(select distinct unnest(t.tags || array['garanzia'])))
from channel_account ca
where ca.id = t.account_id and ca.code like 'garanzia-%' and not ('garanzia' = any(t.tags));

select code, config->'tag_predefiniti' from channel_account where code like 'garanzia-%';
