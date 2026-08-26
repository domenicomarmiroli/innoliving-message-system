-- =====================================================================
-- Hub Messaggi — migrazione 0003: cosa entra in coda, e come si legge
--
-- Nasce da un dato reale: la prima lettura della casella ha prodotto 371
-- conversazioni, di cui circa 150 non erano ticket — avvisi Google,
-- notifiche di consegna non riuscita, posta di servizio. E le altre
-- mostravano il corpo integrale dell'email, impalcatura di Amazon
-- compresa.
--
-- Da eseguire nell'editor SQL di Supabase dopo la 0002.
-- È idempotente.
-- =====================================================================

-- ---------------------------------------------------------------------
-- 1. Opzioni di ingestione
-- ---------------------------------------------------------------------
insert into app_config (key, value) values (
  'mail_ingest',
  jsonb_build_object(
    -- Solo la posta che viene da un canale riconosciuto diventa un
    -- ticket. Il resto resta in Gmail, che è il suo archivio.
    'solo_canali_riconosciuti', true,
    -- Le email più vecchie di tanti giorni entrano già chiuse: servono
    -- nello storico, non in coda.
    'giorni_coda', 7
  )
)
on conflict (key) do update set value = excluded.value, updated_at = now();

-- ---------------------------------------------------------------------
-- 2. Prima di cancellare: guarda cosa stai per cancellare
--
-- Esegui SOLO questa parte, leggi il risultato, poi passa al punto 3.
-- ---------------------------------------------------------------------
select
  split_part(coalesce(m.raw->>'reply_to', m.raw->>'from'), '@', 2) as dominio,
  count(distinct t.id) as conversazioni
from thread t
join message m on m.thread_id = t.id
where t.account_id = (select id from channel_account where kind = 'email')
group by 1
order by conversazioni desc;

-- ---------------------------------------------------------------------
-- 3. Via il rumore
--
-- Tutto ciò che non è stato riconosciuto è finito sull'account della
-- casella: è esattamente l'insieme da togliere. I messaggi vanno via in
-- cascata insieme ai thread.
--
-- ATTENZIONE: se fra questi c'è posta diretta di clienti veri (non da
-- marketplace), questa riga la cancella. Al momento della scrittura non
-- ce n'era: i domini erano google.com, accounts.google.com e amazon.com
-- (notifiche, non messaggi). Ricontrolla il risultato del punto 2 prima
-- di eseguire.
-- ---------------------------------------------------------------------
delete from thread
where account_id = (select id from channel_account where kind = 'email');

-- ---------------------------------------------------------------------
-- 4. Lo storico esce dalla coda
--
-- Le conversazioni la cui ultima email è più vecchia della finestra non
-- sono "in ritardo di 2000 ore": sono concluse. Restano cercabili.
-- ---------------------------------------------------------------------
update thread
set state = 'closed', updated_at = now()
where state <> 'closed'
  and coalesce(last_inbound_at, created_at)
      < now() - ((select coalesce((value->>'giorni_coda')::int, 7)
                  from app_config where key = 'mail_ingest') || ' days')::interval;

-- ---------------------------------------------------------------------
-- 5. Verifica
-- ---------------------------------------------------------------------
select
  ca.code                                            as canale,
  t.state                                            as stato,
  count(*)                                           as conversazioni
from thread t
join channel_account ca on ca.id = t.account_id
group by 1, 2
order by 1, 2;
