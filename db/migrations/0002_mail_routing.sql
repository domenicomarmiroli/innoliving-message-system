-- =====================================================================
-- Hub Messaggi — migrazione 0002: routing della posta
--
-- Da eseguire nell'editor SQL di Supabase dopo la 0001.
-- È idempotente: rieseguirla non rompe nulla.
--
-- Cosa fa:
--  1. crea l'account che rappresenta la CASELLA (serve a sync_state per
--     ricordare l'ultimo UID IMAP letto, e come contenitore dei thread
--     che non riusciamo ad attribuire a nessun marketplace);
--  2. mette in config.sender_domains i domini da cui riconosciamo il
--     canale, così aggiungere un marketplace è una riga di SQL e non
--     una modifica al codice (regola 7 di CLAUDE.md).
-- =====================================================================

-- ---------------------------------------------------------------------
-- 1. La casella come account
-- ---------------------------------------------------------------------
insert into channel_account (kind, code, display_name, locale, transport, config)
values (
  'email', 'mailbox-assistenza', 'Casella assistenza', 'it', 'imap',
  '{"note":"L''indirizzo vero sta in MAIL_USER, non qui: non mettiamo indirizzi nel database di configurazione condiviso."}'::jsonb
)
on conflict (code) do nothing;

-- ---------------------------------------------------------------------
-- 2. Domini mittente per canale
--
-- Il riconoscimento guarda il dominio del mittente (o del Reply-To).
-- I domini Amazon sono uno per marketplace: elencare quelli su cui
-- vendiamo davvero. Aggiungerne uno = aggiornare questo array.
-- ---------------------------------------------------------------------
update channel_account
set config = config || jsonb_build_object(
      'sender_domains', jsonb_build_array(
        'marketplace.amazon.it',
        'marketplace.amazon.de',
        'marketplace.amazon.fr',
        'marketplace.amazon.es',
        'marketplace.amazon.nl',
        'marketplace.amazon.se',
        'marketplace.amazon.pl',
        'marketplace.amazon.com.be'
      ),
      -- Il numero d'ordine Amazon ha un formato fisso e riconoscibile:
      -- è l'unico dato che estraiamo dal testo, e solo come ripiego
      -- quando l'alias non basta.
      'order_id_pattern', '\d{3}-\d{7}-\d{7}'
    ),
    updated_at = now()
where code = 'amazon-it';

-- Mirakl: un solo dominio di relay per tutti gli operatori. La
-- distinzione fra operatori NON si fa dal dominio, si fa dall'ordine
-- agganciato tramite buyer_alias.
update channel_account
set config = config || jsonb_build_object(
      'sender_domains', jsonb_build_array('notification.mirakl.net')
    ),
    updated_at = now()
where kind = 'mirakl';

-- ---------------------------------------------------------------------
-- 3. Verifica
-- Deve restituire una riga per la casella e gli account con i domini.
-- ---------------------------------------------------------------------
select code,
       kind,
       transport,
       config->'sender_domains' as domini_mittente
from channel_account
order by kind, code;
