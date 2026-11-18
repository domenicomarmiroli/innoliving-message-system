-- =====================================================================
-- Hub Messaggi — migrazione 0054: stato della spedizione di reso.
--
-- Per ogni etichetta di reso BRT il worker rilegge il tracking BRT
-- (servizio REST, per `tracking_parcel_id`) e salva qui lo stato, così il
-- riquadro "Garanzia" del ticket mostra a che punto è il pacco.
--
--   spedizione_stato       in_attesa   BRT non ha ancora il pacco (etichetta
--                                      creata, cliente non ancora al punto)
--                          spedito     dati trasmessi / preso in carico
--                          in_transito in viaggio verso il magazzino
--                          in_consegna in consegna al magazzino
--                          consegnato  arrivato al magazzino (stato finale)
--                          giacenza    ferma in filiale
--                          problema    evento anomalo
--   spedizione_eventi      eventi BRT, dal più recente: [{data, ora, filiale, evento}]
--   spedizione_ultimo_evento  testo dell'ultimo evento, per la riga breve
--   spedizione_consegnata_at  data/ora della consegna al magazzino
--   tracking_letto_at      ultima lettura riuscita (anche "non ancora in BRT")
--   tracking_errore        ultimo errore di lettura, null se l'ultima è andata bene
--
-- Il frontend legge la tabella direttamente (policy select già esistente
-- per gli operatori): niente rotte nuove.
--
-- Da eseguire PRIMA del deploy del worker che le usa. Idempotente.
-- =====================================================================

alter table etichetta_reso
  add column if not exists spedizione_stato text,
  add column if not exists spedizione_eventi jsonb,
  add column if not exists spedizione_ultimo_evento text,
  add column if not exists spedizione_consegnata_at timestamptz,
  add column if not exists spedizione_aggiornata_at timestamptz,
  add column if not exists tracking_letto_at timestamptz,
  add column if not exists tracking_errore text;

alter table etichetta_reso drop constraint if exists etichetta_reso_spedizione_stato_check;
alter table etichetta_reso add constraint etichetta_reso_spedizione_stato_check
  check (spedizione_stato is null or spedizione_stato in
    ('in_attesa', 'spedito', 'in_transito', 'in_consegna', 'consegnato', 'giacenza', 'problema'));

-- Il giro cerca le etichette create e non ancora consegnate.
create index if not exists etichetta_reso_da_seguire_idx
  on etichetta_reso (tracking_letto_at nulls first)
  where stato = 'creata' and tracking_parcel_id is not null and spedizione_stato is distinct from 'consegnato';

-- Verifica
select column_name from information_schema.columns
where table_name = 'etichetta_reso' and column_name like any (array['spedizione\_%', 'tracking\_%'])
order by column_name;
