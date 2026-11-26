-- =====================================================================
-- Hub Messaggi — migrazione 0057: il reso consegnato al magazzino riapre
-- il ticket.
--
-- Chiesto da Domenico il 2026-11-26 (ticket 15861): il tracking BRT diceva
-- CONSEGNATA ma il ticket restava com'era. Quando il reso arriva c'è sempre
-- un'azione (rispedire, rimborsare, scrivere al cliente): il ticket torna
-- aperto con una nota interna, e per le garanzie la pratica passa a
-- "rientrata" (con l'avviso al cliente dove scriviamo noi).
--
-- etichetta_reso.riapertura_at: quando il worker ha riaperto il ticket per
-- questo reso. Una volta sola per etichetta.
--
-- Da eseguire PRIMA del deploy del worker che la usa. Idempotente.
-- =====================================================================

alter table etichetta_reso add column if not exists riapertura_at timestamptz;

-- I resi consegnati prima del 24/11 sono già stati gestiti a mano: non si
-- riaprono. Quelli dal 24/11 in poi li riapre il primo giro del worker.
update etichetta_reso
set riapertura_at = coalesce(spedizione_consegnata_at, now())
where spedizione_stato = 'consegnato'
  and riapertura_at is null
  and (spedizione_consegnata_at is null or spedizione_consegnata_at < '2026-11-24T00:00:00+01:00');

create index if not exists etichetta_reso_da_riaprire_idx
  on etichetta_reso (spedizione_consegnata_at)
  where spedizione_stato = 'consegnato' and riapertura_at is null and thread_id is not null;

-- Verifica: quanti si riapriranno al prossimo giro
select count(*) as da_riaprire from etichetta_reso
where spedizione_stato = 'consegnato' and riapertura_at is null and thread_id is not null;
