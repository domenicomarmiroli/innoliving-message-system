-- =====================================================================
-- Hub Messaggi — migrazione 0009: note interne fra operatori
--
-- Una nota non è un messaggio al cliente: è un appunto fra chi lavora
-- sul ticket ("chiamato tre volte, non risponde", "verificare con il
-- fornitore"), con testo ed eventuali allegati, che resta nella stessa
-- cronologia della conversazione ma non esce mai verso il marketplace.
--
-- Da eseguire nell'editor SQL di Supabase dopo la 0008. È idempotente.
-- =====================================================================

alter table message add column if not exists interno boolean not null default false;

-- ---------------------------------------------------------------------
-- Verifica
-- ---------------------------------------------------------------------
select column_name, data_type, column_default
from information_schema.columns
where table_name = 'message' and column_name = 'interno';

-- =====================================================================
-- NOTA PER CHI TOCCA LOVABLE — le note si scrivono direttamente
--
-- Una nota è un dato puramente interno, come i tag o l'assegnazione:
-- niente piattaforma esterna coinvolta, quindi si scrive direttamente
-- su Supabase (message + eventuali attachment collegati), non tramite
-- il worker. Serve una policy RLS di INSERT su entrambe le tabelle per
-- gli utenti autenticati — se non esiste già, è lei il prossimo blocco.
--
-- ATTENZIONE per chi costruirà in futuro le bozze AI (passo 07 del
-- runbook) o qualunque cosa componga testo da mandare al cliente o al
-- modello: le righe con interno = true vanno SEMPRE escluse. Una nota
-- può contenere dati che non devono mai uscire da qui — è la stessa
-- regola 8 di CLAUDE.md sui dati personali fuori dai prompt, applicata
-- a un'intera categoria di messaggi, non solo a un dato specifico.
-- =====================================================================
