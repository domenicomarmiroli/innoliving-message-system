-- 0034 — Tracking BRT letto dalla pagina pubblica (ripiego in attesa di un
-- servizio via API). Vedi src/connectors/brt/.
--
-- Una volta al giorno il worker legge le spedizioni BRT non ancora
-- consegnate (tutti i canali) e scrive qui stato, eventi e consegna
-- prevista. Lo stato BRT è più fine di quello di Zoho (0033), quindi la
-- stessa colonna `spedizione_stato` guadagna nuovi valori.

alter table "order" drop constraint if exists order_spedizione_stato_check;
alter table "order" add constraint order_spedizione_stato_check
  check (spedizione_stato is null or spedizione_stato in (
    'non_spedito', 'spedito', 'in_transito', 'in_consegna',
    'consegnato', 'giacenza', 'problema'
  ));

alter table "order"
  -- [{data, ora, filiale, evento}], dal più recente.
  add column if not exists tracking_eventi            jsonb,
  add column if not exists tracking_consegna_prevista date,
  -- {numero, aperta_il, stato, motivazione, disposizioni} se BRT ne mostra una.
  add column if not exists tracking_giacenza          jsonb,
  add column if not exists tracking_letto_at          timestamptz;

-- La selezione del giro giornaliero: spedizioni non consegnate, per data
-- dell'ultima lettura.
create index if not exists order_tracking_da_leggere_idx
  on "order" (tracking_letto_at nulls first)
  where tracking_number is not null and spedizione_stato is distinct from 'consegnato';
