-- =====================================================================
-- Hub Messaggi — migrazione 0027: casella aziendale su Microsoft 365
--
-- Solo dati, nessuna modifica di schema. Aggiunge la seconda casella,
-- letta e scritta via Microsoft Graph, ACCANTO a quella Gmail: durante
-- la migrazione convivono entrambe, e il worker legge tutte e due.
--
-- La distingue la colonna `transport`, prevista fin dalla 0001 e già
-- valorizzata ('imap' sulla casella Gmail): qui vale 'graph'.
--
-- L'indirizzo NON sta qui (regola 7): sta nella variabile MS_MAILBOX,
-- come quello Gmail sta in MAIL_USER. Le credenziali (MS_TENANT_ID,
-- MS_CLIENT_ID, MS_CLIENT_SECRET) solo nelle variabili di Render.
--
-- Ordine consigliato: prima questa migrazione, POI le variabili MS_* su
-- Render. Al contrario non si rompe niente, ma finché la riga non c'è il
-- ciclo Microsoft scrive nei log "Manca la casella con trasporto
-- 'graph'" a ogni giro.
--
-- Da eseguire nell'editor SQL di Supabase dopo la 0026. È idempotente.
-- =====================================================================

insert into channel_account (kind, code, display_name, locale, transport, sla_minutes, config)
values (
  'email',
  'mailbox-ticket',
  'Casella ticket (Microsoft 365)',
  'it',
  'graph',
  1440,
  '{"note": "L''indirizzo vero sta in MS_MAILBOX, non qui."}'::jsonb
)
on conflict (code) do nothing;

-- ---------------------------------------------------------------------
-- Verifica: devono comparire due righe, una 'imap' e una 'graph'.
-- ---------------------------------------------------------------------
-- select code, transport, active from channel_account where kind = 'email' order by code;
