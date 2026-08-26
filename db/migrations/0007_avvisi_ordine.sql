-- =====================================================================
-- Hub Messaggi — migrazione 0007: gli avvisi su un ordine
--
-- La query sulla 0006 ha rivelato cosa manda amazon.it, e non è rumore:
--   - "La tua richiesta di garanzia Amazon dalla A alla Z per l'ordine…"
--   - "Azione richiesta: Richiesta di rimborso ricevuta per l'ordine…"
--
-- Sono la cosa più urgente che passa da questa casella. Una richiesta di
-- garanzia dalla A alla Z non gestita pesa sulla salute dell'account
-- venditore, e per quelle Amazon NON offre nessuna API: questa email è
-- l'unico modo che abbiamo di sapere che esiste.
--
-- Quindi non solo entrano: entrano con una scadenza corta, agganciate
-- alla conversazione di quell'ordine — o aprendone una, se il cliente
-- non ci aveva mai scritto.
--
-- Da eseguire dopo la 0006. È idempotente.
-- =====================================================================

update app_config
set value = value || jsonb_build_object(
      'domini_avviso', jsonb_build_array('amazon.it'),
      -- Quattro ore, contro le ventiquattro di un messaggio normale:
      -- questi devono stare in cima alla coda.
      'avviso_sla_minuti', 240,
      -- Dall'oggetto al tag. In configurazione perché sono frasi in
      -- italiano: su un marketplace in un'altra lingua cambiano, e non
      -- devono stare nel codice.
      'avviso_tag', jsonb_build_array(
        jsonb_build_array('dalla A alla Z',   'garanzia-a-z'),
        jsonb_build_array('Azione richiesta', 'rimborso-richiesto')
      )
    ),
    updated_at = now()
where key = 'mail_ingest';

select value from app_config where key = 'mail_ingest';

-- =====================================================================
-- NOTA sulla precedenza, che è la parte delicata
--
-- `marketplace.amazon.it` è un SOTTODOMINIO di `amazon.it`. Il
-- riconoscimento confronta per suffisso, quindi senza precauzioni tutti
-- i messaggi dei clienti verrebbero classificati come avvisi di
-- piattaforma e il canale principale si spegnerebbe in silenzio.
--
-- Nel codice l'ordine è: escluso → canale riconosciuto → avviso →
-- notifica → messaggio. Il passaggio "canale riconosciuto" viene PRIMA
-- delle liste per genere, ed è ciò che tiene separati i due casi.
-- C'è un test apposta; se qualcuno lo cancella, questo commento resta.
-- =====================================================================

-- ---------------------------------------------------------------------
-- Dopo la rilettura, per vedere cosa è emerso:
--
--   select unnest(tags) as tag, count(*)
--   from thread group by 1 order by 2 desc;
--
--   -- avvisi che non siamo riusciti ad agganciare a un ordine
--   select tipo, count(*) from ingest_anomaly
--   where tipo like 'avviso_%' group by tipo;
-- ---------------------------------------------------------------------
