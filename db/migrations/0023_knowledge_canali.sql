-- =====================================================================
-- Hub Messaggi — migrazione 0023: knowledge base per canale
--
-- La stessa procedura può valere diversamente da un marketplace
-- all'altro (es. le regole di reso di Amazon non sono quelle di
-- Mirakl), e Domenico deve poter scrivere una voce che vale SOLO per
-- un canale. Ma la maggior parte delle voci resta generale — quindi il
-- default (nessun canale selezionato) deve continuare a valere per
-- tutti, non richiedere di spuntare ogni canale a mano.
--
-- knowledge.canali: text[], NULL o vuoto = vale per tutti i canali.
-- Valorizzato = vale SOLO per i kind elencati (gli stessi valori di
-- channel_account.kind: 'shopify','amazon','mirakl','tiktok','email',
-- 'contatto'). Nessun vincolo CHECK sui valori ammessi: stessa scelta
-- già fatta per knowledge.tag, per non dover toccare una migrazione se
-- domani arriva un nuovo kind di canale.
--
-- NOTA: db/schema.sql non contiene la tabella "knowledge" (mai
-- riesportato da quando è stata introdotta nella migrazione 0010) — non
-- aggiungo qui una voce che non potrei verificare contro lo stato reale.
--
-- Da eseguire dopo la 0022. È idempotente.
-- =====================================================================

alter table knowledge add column if not exists canali text[];

comment on column knowledge.canali is
  'Kind di channel_account a cui si applica questa voce (es. {amazon,mirakl}). NULL o vuoto = vale per tutti i canali.';

create index if not exists knowledge_canali_idx on knowledge using gin (canali);

-- ---------------------------------------------------------------------
-- Verifica
-- ---------------------------------------------------------------------
select column_name, data_type
from information_schema.columns
where table_name = 'knowledge' and column_name = 'canali';
