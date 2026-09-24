-- =====================================================================
-- Hub Messaggi — migrazione 0028: scadenze da ricordare
--
-- Solo dati, nessuna modifica di schema. Una lista di cose che scadono
-- e che, scadendo, fermano un pezzo del sistema senza avvisare. Il
-- portale (Lovable) la legge da app_config e mostra un avviso in cima a
-- tutte le pagine quando manca poco, e un avviso rosso quando è scaduta.
--
-- La prima voce è il client secret della casella Microsoft 365: quando
-- scade la casella smette di leggere e di rispondere, e l'unico segnale
-- sarebbe un errore AADSTS7000222 in sync_state. Qui diventa un avviso
-- visibile a tutti gli operatori due mesi prima.
--
-- Perché nel database e non nel codice dell'interfaccia: al rinnovo si
-- aggiorna una riga (`scade_il`), senza ripubblicare niente. E la lista
-- accoglie le prossime scadenze (una chiave API, un certificato) senza
-- scrivere codice nuovo.
--
-- ATTENZIONE sulla data: il secret è stato consegnato il 23/09/2026 con
-- validità di 24 mesi, da cui 2028-09-23. La data ESATTA è nel portale
-- Azure (Entra ID → Registrazioni app → Certificati e segreti, colonna
-- "Scade"): se è diversa, va corretta qui.
--
-- Leggibile dagli agenti con la policy app_config_agent_select già
-- esistente. Da eseguire nell'editor SQL di Supabase dopo la 0027.
-- È idempotente.
-- =====================================================================

insert into app_config (key, value)
values (
  'scadenze',
  '[
    {
      "codice": "ms_client_secret",
      "etichetta": "Secret della casella Microsoft 365 (ticket)",
      "scade_il": "2028-09-23",
      "avvisa_giorni_prima": 62,
      "istruzioni": "Generare un nuovo segreto client nel portale Azure (Entra ID → Registrazioni app → Certificati e segreti), copiarne il VALORE nella variabile MS_CLIENT_SECRET su Render, poi aggiornare qui la data di scadenza."
    }
  ]'::jsonb
)
on conflict (key) do nothing;

-- ---------------------------------------------------------------------
-- Al rinnovo del secret: aggiornare solo la data.
-- ---------------------------------------------------------------------
-- update app_config
-- set value = jsonb_set(value, '{0,scade_il}', '"2030-09-23"')
-- where key = 'scadenze';
