-- =====================================================================
-- Hub Messaggi — migrazione 0020: sapere che un reso è stato richiesto
-- (a prescindere dal ticket aperto) e ordinare i chiusi per chiusura
--
-- 1) order.reso_richiesto_at
--
-- reso_carrier/reso_tracking_number (migrazione 0018) restano vuoti
-- finché Amazon non emette l'etichetta di rientro — ma un cliente può
-- aver aperto un reso anche prima che quell'etichetta esista, e
-- l'operatore deve vederlo su QUALUNQUE ticket collegato a quell'ordine,
-- non solo su quello che ha ricevuto l'email di notifica. Colonna
-- sull'ordine, non sul thread: un ordine può avere più conversazioni
-- (canali diversi), la richiesta di reso appartiene all'ordine.
--
-- 2) thread.closed_at, con trigger
--
-- La vista "Chiusi" deve mostrare l'ultimo ticket chiuso in cima, in
-- ordine cronologico di chiusura — non l'ultimo aggiornato: un tag
-- aggiunto dopo la chiusura non deve far "risalire" un ticket vecchio.
-- Trigger invece di fidarsi che ogni punto di Lovable che cambia stato
-- si ricordi di scrivere la colonna: un solo posto, corretto sempre.
--
-- Da eseguire dopo la 0019. È idempotente.
-- =====================================================================

alter table "order"
  add column if not exists reso_richiesto_at timestamptz;

comment on column "order".reso_richiesto_at is
  'Quando Amazon ha notificato una richiesta di reso per questo ordine (X-Space-Notification-Type: RETURN_REQUEST). Indipendente da reso_carrier/reso_tracking_number, che arrivano solo se e quando Amazon emette l''etichetta.';

alter table thread
  add column if not exists closed_at timestamptz;

comment on column thread.closed_at is
  'Quando il thread è passato allo stato closed. Impostata dal trigger thread_closed_at_trg, non a mano.';

create or replace function public.thread_set_closed_at()
returns trigger
language plpgsql
as $$
begin
  if new.state = 'closed' and (old.state is distinct from 'closed') then
    new.closed_at := now();
  elsif new.state <> 'closed' and old.state = 'closed' then
    -- Riaperto: la prossima chiusura deve avere una data propria.
    new.closed_at := null;
  end if;
  return new;
end;
$$;

drop trigger if exists thread_closed_at_trg on thread;
create trigger thread_closed_at_trg
  before update on thread
  for each row
  execute function public.thread_set_closed_at();

-- Backfill di cortesia per i thread già chiusi: closed_at = updated_at,
-- meglio di niente per l'ordinamento iniziale della vista. I chiusi da
-- ora in poi avranno una data esatta grazie al trigger.
update thread set closed_at = updated_at
where state = 'closed' and closed_at is null;
