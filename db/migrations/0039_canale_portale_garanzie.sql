-- 0039 — Il portale garanzie (Warranty Wizard, progetto Lovable separato)
-- apre i ticket di riparazione qui, con POST /contatti/:codice/ticket.
--
-- Un account per brand del portale, kind 'contatto' come i siti: stessa
-- rotta, stesso token (CONTATTO_TOKEN), stessa area cliente
-- (/clienti/ticket). Il codice 'garanzia-<brand>' e il nome mostrano
-- all'operatore che il ticket viene dal portale garanzie e non dalla
-- chat del sito. Logo copiato dall'account "contatto" dello stesso brand,
-- se c'è.
--
-- Solo dati, nessuna modifica di schema. Rieseguibile.

insert into channel_account (kind, code, display_name, locale, sla_minutes, config)
select 'contatto', v.code, v.nome, 'it', 1440,
       coalesce((select jsonb_build_object('logo_path', c.config->>'logo_path')
                 from channel_account c
                 where c.code = v.sito and c.config ? 'logo_path'), '{}'::jsonb)
from (values
  ('garanzia-innoliving', 'Garanzie Innoliving', 'contatto-innoliving'),
  ('garanzia-bimar',      'Garanzie Bimar',      'contatto-bimar'),
  ('garanzia-viceversa',  'Garanzie Viceversa',  'contatto-viceversa'),
  ('garanzia-medifit',    'Garanzie Medifit',    null),
  ('garanzia-higo',       'Garanzie HIGO',       null)
) as v(code, nome, sito)
where not exists (select 1 from channel_account ca where ca.code = v.code);

-- Verifica: cinque righe.
select code, display_name, kind, active from channel_account where code like 'garanzia-%' order by code;
