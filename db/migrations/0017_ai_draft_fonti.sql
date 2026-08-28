-- =====================================================================
-- Hub Messaggi — migrazione 0017: le fonti della bozza restano salvate
--
-- ai_draft salva già ogni bozza generata (testo, esito policy, modello),
-- ma non le fonti della knowledge base usate per generarla — quelle
-- tornavano solo nella risposta HTTP di POST /threads/draft, mai scritte
-- su riga. Senza, riaprire una bozza già generata (invece di rigenerarla
-- e consumare credito AI per niente) avrebbe mostrato il testo ma non
-- da dove veniva.
--
-- Da eseguire nell'editor SQL di Supabase dopo la 0016. È idempotente.
-- =====================================================================

alter table ai_draft add column if not exists fonti jsonb not null default '[]'::jsonb;

comment on column ai_draft.fonti is
  'Voci della knowledge base usate per questa bozza: [{id, titolo, fonte}]. Solo per mostrarle di nuovo riaprendo una bozza già generata, non un riferimento vivo — se una voce viene disattivata dopo, questa resta comunque il fedele elenco di cosa fu usato allora.';

-- ---------------------------------------------------------------------
-- Verifica
-- ---------------------------------------------------------------------
select column_name, data_type
from information_schema.columns
where table_name = 'ai_draft' and column_name = 'fonti';
