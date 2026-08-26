-- =====================================================================
-- Hub Messaggi — migrazione 0006: la lista degli esclusi, sui domini veri
--
-- La prima lettura ha mostrato chi scrive davvero a questa casella: 25
-- domini, quasi tutti fornitori e servizi (hosting, database, fatture,
-- notifiche di piattaforma). Nessun cliente.
--
-- Qui li escludiamo per nome. Il confronto è per suffisso di etichetta,
-- quindi una voce copre tutti i sottodomini: `odoo.com` prende anche
-- `innoliving-spa.odoo.com`, `zendesk.com` anche il sottodominio
-- aziendale, e così via.
--
-- Da eseguire dopo la 0005. È idempotente.
-- =====================================================================

update app_config
set value = value || jsonb_build_object(
      'domini_esclusi', jsonb_build_array(
        -- Google: una voce copre accounts. e mail.; googlemail è un
        -- dominio diverso e va elencato a parte.
        'google.com',
        'googlemail.com',
        -- Infrastruttura e strumenti
        'cloudways.com',
        'digitalocean.com',
        'supabase.com',
        'supabase.io',
        'lovable.cloud',
        'lovable.dev',
        'anthropic.com',
        'scalablehq.com',
        'wetransfer.com',
        'fathom.video',
        'makeugc.ai',
        -- Gestionali e piattaforme
        'odoo.com',
        'zendesk.com',
        'shopify.com',
        'responso.com',
        'intercom-mail.com',
        -- Notifiche da venditore, non messaggi di acquirenti.
        -- ATTENZIONE: sta PRIMA di domini_notifica nell'ordine di
        -- valutazione, quindi non finisce fra gli avvisi di mancata
        -- consegna nonostante finisca per amazon.com.
        'sell.amazon.com'
      )
    ),
    updated_at = now()
where key = 'mail_ingest';

-- ---------------------------------------------------------------------
-- NON esclusi, di proposito:
--
--   inshopping.it   il proprio sito. Potrebbe essere il modulo contatti,
--                   e in quel caso è un cliente a tutti gli effetti.
--   amazon.it       32 conversazioni, natura da verificare. Vedi la
--                   query qui sotto prima di decidere.
-- ---------------------------------------------------------------------

select value from app_config where key = 'mail_ingest';

-- ---------------------------------------------------------------------
-- Cosa manda amazon.it? (dominio diverso da marketplace.amazon.it,
-- che è quello dei messaggi dei clienti)
-- ---------------------------------------------------------------------
select left(m.raw->>'subject', 80) as oggetto, count(*) as quanti
from message m
join thread t on t.id = m.thread_id
where split_part(coalesce(m.raw->>'reply_to', m.raw->>'from'), '@', 2) = 'amazon.it'
group by 1
order by quanti desc
limit 20;
