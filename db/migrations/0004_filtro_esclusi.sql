-- =====================================================================
-- Hub Messaggi — migrazione 0004: il filtro diventa una lista di esclusi
--
-- Sostituisce la scelta fatta nella 0003. Lì la regola era "entra solo
-- ciò che viene da un canale riconosciuto": comoda, ma con un difetto
-- serio — un cliente che scrive direttamente alla casella spariva in
-- silenzio, e il silenzio è il modo peggiore di sbagliare.
--
-- Ora vale il contrario: entra tutto, tranne i domini elencati qui.
-- Il caso peggiore diventa un po' di rumore in coda, che si vede.
--
-- Da eseguire nell'editor SQL di Supabase dopo la 0003. È idempotente.
-- =====================================================================

update app_config
set value = jsonb_build_object(
      -- Confronto per suffisso di etichetta: 'google.com' copre da solo
      -- accounts.google.com, mail.google.com e ogni altro sottodominio.
      'domini_esclusi', jsonb_build_array('google.com'),
      'giorni_coda', coalesce((value->>'giorni_coda')::int, 7)
    ),
    updated_at = now()
where key = 'mail_ingest';

insert into app_config (key, value)
select 'mail_ingest',
       jsonb_build_object('domini_esclusi', jsonb_build_array('google.com'),
                          'giorni_coda', 7)
where not exists (select 1 from app_config where key = 'mail_ingest');

-- ---------------------------------------------------------------------
-- Verifica
-- ---------------------------------------------------------------------
select value from app_config where key = 'mail_ingest';

-- =====================================================================
-- PROMEMORIA — le notifiche di mancata consegna
--
-- Con questa regola rientrano in coda anche le 130 email da amazon.com
-- "Il tuo messaggio all'acquirente non è stato consegnato". Non sono
-- richieste di clienti, ma dicono che altrettante nostre risposte non
-- sono mai arrivate: vale la pena leggerle prima di nasconderle.
--
-- Quando avranno detto ciò che dovevano, si escludono così:
--
--   update app_config
--   set value = jsonb_set(value, '{domini_esclusi}',
--         (value->'domini_esclusi') || '"amazon.com"'::jsonb),
--       updated_at = now()
--   where key = 'mail_ingest';
--
-- Attenzione a NON escludere 'marketplace.amazon.it': è il relay da cui
-- arrivano i messaggi veri dei clienti. Sono domini diversi, e il
-- confronto per suffisso li tiene giustamente separati.
-- =====================================================================
