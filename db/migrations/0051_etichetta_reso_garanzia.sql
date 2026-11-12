-- =====================================================================
-- Hub Messaggi — migrazione 0051: tipologia "garanzia" per le etichette
-- di reso.
--
-- Etichetta per un prodotto guasto in garanzia: foglio senza rimborso né
-- addebiti, tipologia "PRODOTTO IN GARANZIA" per la logistica, messaggio
-- al cliente dal modello "Reso Garanzia" della tabella template.
--
-- Da eseguire PRIMA del deploy del worker che la usa. Idempotente.
-- =====================================================================

alter table etichetta_reso drop constraint if exists etichetta_reso_tipo_check;
alter table etichetta_reso add constraint etichetta_reso_tipo_check
  check (tipo in ('recesso', 'danneggiato', 'verificare', 'garanzia'));

-- Verifica
select pg_get_constraintdef(oid) from pg_constraint
where conrelid = 'etichetta_reso'::regclass and conname = 'etichetta_reso_tipo_check';
