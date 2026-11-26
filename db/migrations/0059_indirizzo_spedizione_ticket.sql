-- =====================================================================
-- Hub Messaggi, migrazione 0059: l'indirizzo di spedizione resta sul ticket.
--
-- Segnalato da Domenico il 2026-11-26 (#17204): nel riquadro Sostitutivo
-- l'indirizzo scritto dall'operatore spariva uscendo dal ticket, e per i
-- ticket nati prima del portale nuovo non veniva proposto quello di ritiro.
-- Ora l'operatore lo salva sul ticket e l'ordine sostitutivo lo riscrive.
--
-- Da eseguire PRIMA del deploy del worker che la usa. Idempotente.
-- =====================================================================

alter table thread add column if not exists indirizzo_spedizione jsonb;
alter table thread add column if not exists indirizzo_spedizione_at timestamptz;

select count(*) as ticket_con_indirizzo from thread where indirizzo_spedizione is not null;
