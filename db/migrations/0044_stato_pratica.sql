-- =====================================================================
-- Hub Messaggi — migrazione 0044: stato della pratica e avvisi al cliente
--
-- Priorità n. 1 del report sulle conversazioni del partner garanzie
-- (08/10): la domanda più frequente dei clienti è "a che punto è?", ed è
-- la prima causa dei giudizi negativi. Ogni cambio di stato di una pratica
-- di assistenza o di reso manda da solo un messaggio al cliente.
--
--   thread.stato_pratica   dove si trova la pratica, per il cliente.
--                          Lo aggiorna il worker quando lo sa (garanzia
--                          registrata, rientro in magazzino con l'esito)
--                          e l'operatore per il resto (etichetta inviata,
--                          prodotto spedito).
--   pratica_evento         un evento per stato: il registro di cosa è
--                          successo e se l'avviso è partito. Unico per
--                          (thread, stato): rileggere lo stesso rientro
--                          dieci volte non manda dieci email (regola 2).
--   app_config.pratica_avvisi
--                          i testi degli avvisi, modificabili senza toccare
--                          il codice. Segnaposto: {numero}, {tracking},
--                          {corriere}, {link_tracking}.
--
-- Avvisi solo sui canali in cui scriviamo noi al cliente (email, siti,
-- telefono, portali garanzie). Su Amazon e Mirakl il cliente lo informa
-- il marketplace: lì l'evento diventa una nota interna (avviso
-- 'non_previsto').
--
-- Da eseguire PRIMA del deploy del worker che la usa. Idempotente.
-- =====================================================================

alter table thread add column if not exists stato_pratica text;
alter table thread add column if not exists stato_pratica_at timestamptz;

alter table thread drop constraint if exists thread_stato_pratica_check;
alter table thread add constraint thread_stato_pratica_check check (stato_pratica in (
  'ricevuta',
  'etichetta_inviata',
  'rientrata',
  'rientrata_sostituzione',
  'rientrata_sostituzione_altro_modello',
  'rientrata_riparazione',
  'rientrata_funzionante',
  'rientrata_non_conforme',
  'spedita',
  'chiusa'
));

create table if not exists pratica_evento (
  id          bigint generated always as identity primary key,
  thread_id   uuid not null references thread(id) on delete cascade,
  stato       text not null,
  origine     text not null,          -- 'portale', 'magazzino', 'operatore'
  dettagli    jsonb not null default '{}'::jsonb,
  avviso      text not null default 'da_inviare'
              check (avviso in ('da_inviare', 'inviato', 'non_previsto', 'fallito')),
  message_id  uuid references message(id),
  errore      text,
  agent_id    uuid,
  created_at  timestamptz not null default now(),
  inviato_at  timestamptz,
  unique (thread_id, stato)
);

create index if not exists pratica_evento_da_inviare_idx on pratica_evento (created_at) where avviso = 'da_inviare';

alter table pratica_evento enable row level security;
drop policy if exists pratica_evento_agent_select on pratica_evento;
create policy pratica_evento_agent_select on pratica_evento for select to authenticated using (public.is_agent());

insert into app_config (key, value)
values (
  'pratica_avvisi',
  '{
    "ricevuta": "Buongiorno,\nabbiamo ricevuto la sua richiesta di assistenza (pratica n. {numero}). La stiamo verificando e le scriveremo con le istruzioni per i prossimi passi.\nPer qualunque aggiornamento può rispondere a questa email.",
    "etichetta_inviata": "Buongiorno,\nle abbiamo inviato l''etichetta per spedirci il prodotto (pratica n. {numero}). La stampi, la applichi sul pacco ben imballato e lo porti in un qualsiasi punto BRT: non serve prenotare il ritiro né scegliere un punto in anticipo.\nAppena il prodotto arriva al nostro magazzino la avvisiamo.",
    "rientrata": "Buongiorno,\nil suo prodotto è arrivato al nostro magazzino (pratica n. {numero}) ed è in verifica. Le scriveremo appena avremo l''esito.",
    "rientrata_sostituzione": "Buongiorno,\nil suo prodotto è arrivato al nostro magazzino (pratica n. {numero}). Abbiamo verificato il difetto e le invieremo un prodotto nuovo in sostituzione. Appena partirà le manderemo il numero di tracciamento.",
    "rientrata_sostituzione_altro_modello": "Buongiorno,\nil suo prodotto è arrivato al nostro magazzino (pratica n. {numero}). Abbiamo verificato il difetto: il modello non è più disponibile, quindi le invieremo in sostituzione un modello equivalente. Appena partirà le manderemo il numero di tracciamento.",
    "rientrata_riparazione": "Buongiorno,\nil suo prodotto è arrivato al nostro magazzino (pratica n. {numero}) e verrà riparato. Appena lo rispediremo le manderemo il numero di tracciamento.",
    "rientrata_funzionante": "Buongiorno,\nil suo prodotto è arrivato al nostro magazzino (pratica n. {numero}). Dalle nostre verifiche il prodotto risulta funzionante e glielo rispediremo. Se il problema dovesse ripresentarsi, risponda a questa email descrivendo cosa succede: la aiuteremo a capire come risolverlo.",
    "rientrata_non_conforme": "Buongiorno,\nil suo prodotto è arrivato al nostro magazzino (pratica n. {numero}). Dalla verifica sono emerse delle anomalie che dobbiamo valutare: un nostro collega le scriverà a breve.",
    "spedita": "Buongiorno,\nle abbiamo spedito il prodotto (pratica n. {numero}).\nCorriere: {corriere}\nNumero di tracciamento: {tracking}\n{link_tracking}"
  }'::jsonb
)
on conflict (key) do nothing;

-- Verifica
select key from app_config where key = 'pratica_avvisi';
