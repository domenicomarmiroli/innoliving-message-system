-- =====================================================================
-- Hub Messaggi — migrazione 0032: ticket dal telefono e numero breve
--
-- 1. Nuovo genere di canale 'telefono': i ticket aperti dall'agente
--    vocale (ElevenLabs) entrano nella stessa coda di tutti gli altri,
--    con le stesse viste e scadenze. Un solo account.
--
-- 2. `thread.numero`: un numero progressivo breve per OGNI ticket. Un
--    UUID non si può dettare al telefono ("il suo ticket è il 10234"), e
--    serve anche in interfaccia per cercare un ticket a voce fra
--    colleghi. Parte da 10001, così è sempre di almeno cinque cifre. I
--    ticket già esistenti ricevono un numero adesso, quelli nuovi alla
--    creazione: nessun codice deve assegnarlo a mano.
--
-- Da eseguire nell'editor SQL di Supabase dopo la 0031, PRIMA del deploy
-- del worker che apre i ticket telefonici. È idempotente.
-- =====================================================================

alter table channel_account drop constraint if exists channel_account_kind_check;
alter table channel_account add constraint channel_account_kind_check
  check (kind in ('shopify', 'amazon', 'mirakl', 'tiktok', 'email', 'contatto', 'telefono'));

insert into channel_account (kind, code, display_name, locale, sla_minutes, config)
values (
  'telefono',
  'telefono-ai',
  'Telefono (assistente vocale)',
  'it',
  480,
  '{"note": "Ticket aperti dall''agente vocale ElevenLabs (rotte /voce/* del worker)."}'::jsonb
)
on conflict (code) do nothing;

create sequence if not exists thread_numero_seq start with 10001;

alter table thread add column if not exists numero bigint;
alter table thread alter column numero set default nextval('thread_numero_seq');
alter sequence thread_numero_seq owned by thread.numero;

-- I ticket esistenti, in ordine di creazione: il più vecchio ha il numero
-- più basso.
update thread t
set numero = n.numero
from (
  select id, nextval('thread_numero_seq') as numero
  from (select id from thread where numero is null order by created_at, id) x
) n
where t.id = n.id;

alter table thread alter column numero set not null;
create unique index if not exists thread_numero_key on thread (numero);

-- L'interfaccia (ruolo authenticated) inserisce ticket? No, ma legge il
-- numero: nessuna policy nuova, la colonna è coperta da quelle di thread.
-- La sequenza va però resa usabile a chi inserisce righe in thread.
grant usage on sequence thread_numero_seq to authenticated, service_role;

-- ---------------------------------------------------------------------
-- Verifica: account presente, nessun ticket senza numero
-- ---------------------------------------------------------------------
select
  (select count(*) from channel_account where kind = 'telefono') as account_telefono,
  (select count(*) from thread where numero is null) as senza_numero,
  (select min(numero) from thread) as primo,
  (select max(numero) from thread) as ultimo;
