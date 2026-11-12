-- =====================================================================
-- Hub Messaggi — migrazione 0052: avviso automatico al cliente per le
-- spedizioni in giacenza o con un problema di consegna.
--
-- Nuova azione 'avviso_spedizione' per la tabella automazione (0050). Il
-- worker, nel ciclo principale, prende gli ordini con spedizione_stato
-- negli stati della regola, non segnati "gestita" dall'operatore, con un
-- evento BRT recente (parametri.max_eta_ore) e un'email a cui si può
-- scrivere (condizione.domini_esclusi), e apre un ticket in uscita dalla
-- casella Microsoft con il modello dello stato. Un avviso per ordine e
-- per stato (automazione_esecuzione, chiave spedizione:<ordine>:<stato>).
--
-- Esclusi di partenza:
--   codisto.com     email degli ordini Amazon via connettore: non arriva
--   bricobravo.com  indirizzo del marketplace, non del cliente
--
-- La regola nasce SPENTA. Si accende con:
--   update automazione set attiva = true, updated_at = now()
--   where codice = 'avviso-spedizione-problema';
--
-- I due modelli si modificano come gli altri della tabella template.
-- Segnaposto disponibili: {{cliente.nome}} {{ordine.numero}}
-- {{tracking.numero}} {{tracking.link}} {{tracking.eventi}}
-- {{tracking.ultimo_evento}} {{giacenza.numero}} {{giacenza.motivo}}.
-- Una riga i cui segnaposto sono tutti vuoti non viene spedita.
--
-- Da eseguire nell'editor SQL di Supabase. Idempotente.
-- =====================================================================

alter table automazione drop constraint if exists automazione_azione_check;
alter table automazione add constraint automazione_azione_check
  check (azione in ('chiudi', 'rispondi_e_chiudi', 'avviso_spedizione'));

-- allowed_kinds vuoto: non compaiono nella tendina dell'editor, perché
-- hanno segnaposto che solo il worker sa compilare.
insert into template (name, locale, allowed_kinds, subject_tpl, body_tpl, requires_review)
select 'Avviso spedizione in giacenza', 'it', '{}',
  'La sua spedizione per l''ordine {{ordine.numero}} è in giacenza',
  $tpl$Buongiorno {{cliente.nome}},

le scriviamo per il suo ordine {{ordine.numero}}: il corriere BRT non è riuscito a consegnare il pacco e ora la spedizione è in giacenza presso la filiale.

Motivo indicato dal corriere: {{giacenza.motivo}}
Numero di giacenza: {{giacenza.numero}}

Può seguire la spedizione qui: {{tracking.link}}
Numero di spedizione BRT: {{tracking.numero}}

Ultimi aggiornamenti del corriere:
{{tracking.eventi}}

Per evitare che il pacco torni indietro, ci risponda a questa email indicando:
- un indirizzo alternativo a cui consegnarlo, oppure
- una data in cui far ritentare la consegna.

Può anche contattare direttamente BRT con il numero di spedizione qui sopra.

Cordiali saluti$tpl$,
  false
where not exists (select 1 from template where name = 'Avviso spedizione in giacenza');

insert into template (name, locale, allowed_kinds, subject_tpl, body_tpl, requires_review)
select 'Avviso problema di consegna', 'it', '{}',
  'Problema nella consegna del suo ordine {{ordine.numero}}',
  $tpl$Buongiorno {{cliente.nome}},

le scriviamo per il suo ordine {{ordine.numero}}: il corriere BRT ha segnalato un problema nella consegna del pacco.

Ultima segnalazione del corriere: {{tracking.ultimo_evento}}

Può seguire la spedizione qui: {{tracking.link}}
Numero di spedizione BRT: {{tracking.numero}}

Ultimi aggiornamenti del corriere:
{{tracking.eventi}}

Le chiediamo di verificare con BRT, usando il numero di spedizione qui sopra. Se il pacco dovesse finire in giacenza, ci risponda a questa email indicando un indirizzo alternativo o una data in cui far ritentare la consegna.

Cordiali saluti$tpl$,
  false
where not exists (select 1 from template where name = 'Avviso problema di consegna');

insert into automazione (codice, descrizione, attiva, account_code, condizione, azione, parametri)
values (
  'avviso-spedizione-problema',
  'Spedizione BRT in giacenza o con problema di consegna: avviso al cliente con tracking ed eventi, '
    || 'se la sua email è contattabile. Un avviso per ordine e per stato.',
  false,
  null,
  jsonb_build_object(
    'stati_spedizione', jsonb_build_array('giacenza', 'problema'),
    'domini_esclusi',   jsonb_build_array('codisto.com', 'bricobravo.com')
  ),
  'avviso_spedizione',
  jsonb_build_object(
    'modelli', jsonb_build_object(
      'giacenza', 'Avviso spedizione in giacenza',
      'problema', 'Avviso problema di consegna'
    ),
    'max_eta_ore', 72
  )
)
on conflict (codice) do nothing;

-- Verifica
select codice, attiva, azione from automazione order by codice;
select name from template where name in ('Avviso spedizione in giacenza', 'Avviso problema di consegna');
