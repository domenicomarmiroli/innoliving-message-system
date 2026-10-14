-- =====================================================================
-- Hub Messaggi — migrazione 0045: etichetta di reso BRT dal ticket
--
-- Sostituisce il worker esterno su Cloudways che generava la lettera di
-- vettura di reso partendo da un pulsante su Zoho. Ora parte dal ticket:
-- l'operatore sceglie la tipologia, il worker chiede l'etichetta a BRT,
-- compone il foglio per il cliente (istruzioni + etichetta + tipologia
-- in evidenza per la logistica), lo carica su Storage e scrive il
-- segnacollo nel modulo Zoho "LDV Reso", come faceva il vecchio worker.
--
--   etichetta_reso      una riga per etichetta. Unica per (thread, tipo):
--                       premere due volte il pulsante non crea due
--                       spedizioni BRT, restituisce la stessa (regola 2).
--                       La riga nasce 'in_corso' PRIMA della chiamata a
--                       BRT, così due richieste contemporanee non
--                       arrivano entrambe a BRT.
--   app_config.brt_resi destinatario del reso (il magazzino), codici del
--                       contratto BRT, testi del foglio. Non segreti: la
--                       password BRT sta in BRT_API_PASSWORD su Render.
--
-- Da eseguire PRIMA del deploy del worker che la usa. Idempotente.
-- =====================================================================

create table if not exists etichetta_reso (
  id                   uuid primary key default gen_random_uuid(),
  thread_id            uuid not null references thread(id) on delete cascade,
  order_id             uuid references "order"(id),
  tipo                 text not null check (tipo in ('recesso', 'danneggiato', 'verificare')),
  stato                text not null default 'in_corso' check (stato in ('in_corso', 'creata', 'fallita')),
  -- Segnacollo (18 cifre) e codice per il tracking via API (15 cifre).
  parcel_id            text unique,
  tracking_parcel_id   text,
  storage_path         text,
  nome_file            text,
  -- Numero dell'ordine di vendita Zoho (es. AMZS404-…), scritto nel modulo LDV Reso.
  zoho_ordine          text,
  zoho_scritto_at      timestamptz,
  zoho_errore          text,
  errore               text,
  -- Risposta integrale di BRT senza i byte dell'etichetta (stanno su Storage).
  raw                  jsonb,
  agent_id             uuid,
  created_at           timestamptz not null default now(),
  updated_at           timestamptz not null default now(),
  unique (thread_id, tipo)
);

create index if not exists etichetta_reso_order_idx on etichetta_reso (order_id);

alter table etichetta_reso enable row level security;
drop policy if exists etichetta_reso_agent_select on etichetta_reso;
create policy etichetta_reso_agent_select on etichetta_reso for select to authenticated using (public.is_agent());

insert into app_config (key, value)
values (
  'brt_resi',
  '{
    "endpoint": "https://api.brt.it/rest/v1/shipments/shipment",
    "codice_cliente": "1402987",
    "filiale_partenza": 140,
    "codice_tariffa": "301",
    "codice_servizio": "B15",
    "filiale_ritorno": "1402987500",
    "peso_kg": 2.0,
    "destinatario": {
      "ragione_sociale": "Innoliving S.p.A.",
      "indirizzo": "Via Merloni, 2b",
      "cap": "60131",
      "citta": "Ancona",
      "provincia": "AN",
      "paese": "IT",
      "email": "ticket@innoliving.it",
      "telefono": "+39 071 2867616"
    },
    "foglio": {
      "email_assistenza": "ticket@innoliving.it",
      "url_punti_ritiro": "https://www.mybrt.it/it/mybrt/parcel-shops",
      "costo_reso_recesso": "6,00"
    },
    "zoho": {
      "modulo": "cm_ldv_reso_amazon",
      "prefisso_amazon": "AMZS"
    }
  }'::jsonb
)
on conflict (key) do nothing;

-- Verifica
select key from app_config where key = 'brt_resi';
