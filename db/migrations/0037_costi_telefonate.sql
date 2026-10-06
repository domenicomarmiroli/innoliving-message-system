-- 0037 — Costi e indicatori delle telefonate, per la dashboard vocale.
--
-- Valori dal webhook di fine chiamata (data.metadata.cost e
-- data.metadata.charging), scritti dal worker a ogni chiamata. Le righe
-- già presenti si ricavano qui dal payload originale (raw).

alter table voice_call
  add column if not exists costo_crediti   integer,   -- metadata.cost: totale addebitato
  add column if not exists crediti_voce    integer,   -- charging.call_charge: trascrizione + voce
  add column if not exists crediti_llm     integer,   -- charging.llm_charge: modello di linguaggio
  add column if not exists costo_usd       numeric(10,5), -- platform_price + llm_price, stima di ElevenLabs
  add column if not exists chiamata_test   boolean,   -- charging.dev_discount: test dal simulatore, scontata
  add column if not exists verificato      boolean,   -- il cliente ha superato la verifica in chiamata
  add column if not exists ticket_aperto   boolean;   -- l'agente ha aperto un ticket nuovo

update voice_call vc set
  costo_crediti = nullif(raw #>> '{data,metadata,cost}', '')::numeric::integer,
  crediti_voce  = nullif(raw #>> '{data,metadata,charging,call_charge}', '')::numeric::integer,
  crediti_llm   = nullif(raw #>> '{data,metadata,charging,llm_charge}', '')::numeric::integer,
  costo_usd     = coalesce(nullif(raw #>> '{data,metadata,charging,platform_price}', '')::numeric, 0)
                + coalesce(nullif(raw #>> '{data,metadata,charging,llm_price}', '')::numeric, 0),
  chiamata_test = (raw #>> '{data,metadata,charging,dev_discount}')::boolean,
  verificato    = exists (select 1 from voice_session vs where vs.conversation_id = vc.conversation_id),
  ticket_aperto = exists (
    select 1 from thread t join channel_account ca on ca.id = t.account_id
    where ca.kind = 'telefono' and t.external_thread_id = vc.conversation_id
  )
where costo_crediti is null;
