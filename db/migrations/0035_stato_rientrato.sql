-- 0035 — Spedizione tornata al mittente ("Reso mittente" nell'interfaccia).
-- Caso reale 06/10: pacco rifiutato, giacenza con disposizione RIENTRO,
-- RESO MITTENTE, poi CONSEGNATA — ma consegnata a noi. Prima risultava
-- "consegnato". Vedi connectors/brt/pagina.ts, rientrataAlMittente().

alter table "order" drop constraint if exists order_spedizione_stato_check;
alter table "order" add constraint order_spedizione_stato_check
  check (spedizione_stato is null or spedizione_stato in (
    'non_spedito', 'spedito', 'in_transito', 'in_consegna',
    'consegnato', 'giacenza', 'problema', 'rientrato'
  ));
