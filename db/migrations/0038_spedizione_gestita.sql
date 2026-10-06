-- 0038 — "Gestita" nella vista Spedizioni con problemi.
--
-- L'operatore segna la spedizione come gestita (scrittura diretta da
-- Lovable: gli agenti possono già aggiornare "order", policy della 0001) e
-- sparisce dalla vista. Il worker azzera il segno quando lo stato BRT
-- cambia (connectors/brt/tracking.ts): un problema NUOVO sulla stessa
-- spedizione torna in lista invece di restare nascosto.

alter table "order"
  add column if not exists spedizione_gestita_at timestamptz,
  add column if not exists spedizione_gestita_da uuid references agent(id) on delete set null;
