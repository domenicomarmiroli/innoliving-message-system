-- 0033 — Stato della spedizione dal gestionale (pacchetti Zoho).
--
-- Gli ordini Amazon arrivano da Shopify senza tracking né evasione
-- aggiornata: il dato vero sta nel pacchetto Zoho dell'ordine AMZS<numero>
-- (vettore, numero di spedizione, stato shipped/delivered). Il worker lo
-- legge a ogni giro (connectors/magazzino/spedizioni.ts) per TUTTI gli
-- ordini Amazon della finestra, non solo per quelli con un ticket: serve
-- anche all'agente vocale, che deve poter dire "consegnato".
--
-- Valori di spedizione_stato: 'non_spedito' | 'spedito' | 'consegnato'.
-- NULL = nessun dato dal gestionale (vale lo stato Shopify, come prima).

alter table "order"
  add column if not exists spedizione_stato         text,
  add column if not exists spedizione_data          date,
  add column if not exists spedizione_aggiornata_at timestamptz;

alter table "order" drop constraint if exists order_spedizione_stato_check;
alter table "order" add constraint order_spedizione_stato_check
  check (spedizione_stato is null or spedizione_stato in ('non_spedito', 'spedito', 'consegnato'));
