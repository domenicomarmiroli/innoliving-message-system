-- =====================================================================
-- Hub Messaggi — migrazione 0050: automazioni sui ticket
--
-- Regole che agiscono da sole su certi messaggi in arrivo. Stanno qui e
-- non nel codice (regola 7): aggiungerne una è una riga, spegnerla è un
-- `update ... set attiva = false`.
--
--   automazione             una riga per regola, con il suo interruttore
--   automazione_esecuzione  il registro: una riga per ogni volta che una
--                           regola è scattata, con l'esito. Serve a contare
--                           e rende la regola ripetibile senza doppioni
--                           (unica per regola + chiave).
--
-- Due azioni oggi:
--   chiudi             il messaggio entra come sempre ma non rimette il
--                      ticket in coda; un ticket aperto solo per messaggi
--                      di questo tipo si chiude con una nota interna.
--                      Chiave del registro: 'messaggio:<id>'.
--   rispondi_e_chiudi  (solo Mirakl) risponde nel thread con un modello
--                      della tabella `template` e chiude, UNA volta per
--                      thread. Chiave del registro: 'thread:<id>'.
--
-- Le due regole di partenza nascono SPENTE (attiva = false). Si accendono
-- solo con il via di Domenico:
--   update automazione set attiva = true, updated_at = now()
--   where codice = 'bricobravo-nuovo-ordine';
--
-- Da eseguire nell'editor SQL di Supabase PRIMA del deploy del worker che
-- la usa (il worker tollera comunque l'assenza della tabella: nessuna
-- regola, nessun effetto). Idempotente.
-- =====================================================================

create table if not exists automazione (
  id            uuid primary key default gen_random_uuid(),
  codice        text not null unique,
  descrizione   text not null,
  attiva        boolean not null default false,
  -- channel_account.code su cui vale la regola; null = qualunque account
  account_code  text,
  -- { "oggetto_inizia_per": [...], "oggetto_uguale": [...], "mittente_dominio": [...] }
  -- Almeno una delle due liste sull'oggetto è obbligatoria: una regola
  -- senza condizioni sull'oggetto non scatta mai (controllo nel worker).
  condizione    jsonb not null,
  azione        text not null check (azione in ('chiudi', 'rispondi_e_chiudi')),
  -- { "nota": "...", "modello": "<template.name>", "destinatari_mirakl": ["CUSTOMER"],
  --   "tag": [...], "max_eta_ore": 48 }
  parametri     jsonb not null default '{}'::jsonb,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);

create table if not exists automazione_esecuzione (
  id              uuid primary key default gen_random_uuid(),
  automazione_id  uuid not null references automazione(id) on delete cascade,
  chiave          text not null,
  thread_id       uuid references thread(id) on delete cascade,
  -- il messaggio che ha fatto scattare la regola
  message_id      uuid references message(id) on delete set null,
  -- la risposta automatica spedita (solo rispondi_e_chiudi)
  risposta_id     uuid references message(id) on delete set null,
  esito           text not null check (esito in (
                    'in_corso',        -- risposta in partenza
                    'inviato',         -- risposta spedita e ticket chiuso
                    'chiuso',          -- ticket chiuso dalla regola
                    'gia_chiuso',      -- messaggio archiviato, ticket già chiuso
                    'lasciato_aperto', -- nel ticket c'è altro da guardare
                    'errore'           -- vedi colonna errore e ingest_anomaly
                  )),
  errore          text,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  unique (automazione_id, chiave)
);

create index if not exists automazione_esecuzione_thread_idx
  on automazione_esecuzione (thread_id);
create index if not exists automazione_esecuzione_data_idx
  on automazione_esecuzione (automazione_id, created_at);

-- Dato interno, come tag e rubrica: gli operatori leggono il registro e
-- possono accendere/spegnere le regole dall'interfaccia.
alter table automazione enable row level security;
drop policy if exists automazione_agent_all on automazione;
create policy automazione_agent_all on automazione
  for all to authenticated using (public.is_agent()) with check (public.is_agent());

alter table automazione_esecuzione enable row level security;
drop policy if exists automazione_esecuzione_agent_select on automazione_esecuzione;
create policy automazione_esecuzione_agent_select on automazione_esecuzione
  for select to authenticated using (public.is_agent());

-- ---------------------------------------------------------------------
-- Le due regole di partenza, SPENTE.
-- ---------------------------------------------------------------------

insert into automazione (codice, descrizione, attiva, account_code, condizione, azione, parametri)
values (
  'bricobravo-nuovo-ordine',
  'Avviso "Nuovo ordine" di BricoBravo: si archivia senza risposta e non va in coda. '
    || 'Non tocca "prodotto non presente su Shopify" né le risposte ai reclami.',
  false,
  'mailbox-ticket',
  jsonb_build_object(
    'oggetto_inizia_per', jsonb_build_array('BricoBravo - Nuovo ordine #BB'),
    'mittente_dominio',   jsonb_build_array('bricobravo.com')
  ),
  'chiudi',
  jsonb_build_object(
    'nota', 'Chiuso in automatico: avviso nuovo ordine BricoBravo.'
  )
)
on conflict (codice) do nothing;

insert into automazione (codice, descrizione, attiva, account_code, condizione, azione, parametri)
values (
  'leroymerlin-richiesta-fattura',
  'Richiesta fattura di Leroy Merlin (notifica dell''operatore): risposta col modello '
    || '"Fattura Leroymerlin" al cliente e chiusura. Una sola volta per thread.',
  false,
  'mirakl-lmfr',
  jsonb_build_object(
    'oggetto_uguale', jsonb_build_array('ORDER_MESSAGING_askinvoice', 'ORDER_MESSAGING_REMINDER_ASKINVOICE')
  ),
  'rispondi_e_chiudi',
  jsonb_build_object(
    'modello', 'Fattura Leroymerlin',
    'destinatari_mirakl', jsonb_build_array('CUSTOMER'),
    'tag', jsonb_build_array('risposta-automatica'),
    'max_eta_ore', 48
  )
)
on conflict (codice) do nothing;

-- Verifica
select codice, attiva, account_code, azione from automazione order by codice;

-- Per contare, quando le regole sono accese:
--   select a.codice, e.esito, count(*)
--   from automazione_esecuzione e join automazione a on a.id = e.automazione_id
--   where e.created_at > now() - interval '30 days'
--   group by 1, 2 order by 1, 2;
