-- =====================================================================
-- Hub Messaggi — dati dimostrativi per costruire l'interfaccia
--
-- Ordini VERI presi dal catalogo Shopify di agosto 2026, con conversazioni
-- verosimili costruite sui casi realmente visti nella casella.
-- Serve a sviluppare e valutare le schermate prima che il worker sia in
-- funzione: un'interfaccia disegnata sul vuoto è disegnata sull'immaginazione.
--
-- Tutti i thread sono etichettati 'demo'. Per rimuoverli in un colpo:
--   delete from thread where 'demo' = any(tags);
--   delete from "order" where raw->>'demo' = 'true';
--
-- Le scadenze sono relative a now(), così le barre di scadenza si muovono
-- davvero invece di essere sempre uguali.
-- =====================================================================

begin;

-- Pulizia di un'eventuale esecuzione precedente ------------------------
delete from thread where 'demo' = any(tags);
delete from "order" where raw->>'demo' = 'true';
delete from channel_identity where external_id like '%notification.mirakl.net'
   or external_id like '%marketplace.amazon.it';

-- =====================================================================
-- ORDINI
-- =====================================================================

insert into "order" (channel, external_order_id, shopify_gid, shopify_name, operator,
                     buyer_alias, placed_at, financial_status, fulfillment_status,
                     tracking_number, tracking_url, carrier, total, currency, raw) values

('mirakl','02116_325104572-A','gid://shopify/Order/17732393861469','INSH6406','MediaMarktSaturn',
 'rk0idlx32ez.fznm52pke@notification.mirakl.net','2026-08-24T15:09:19Z','paid','unfulfilled',
 null,null,null,24.90,'EUR','{"demo":"true"}'),

('mirakl','02116_324918498-A','gid://shopify/Order/17712694755677','INSH6401','MediaMarktSaturn',
 'rnrg0za9bin.fznm52pke@notification.mirakl.net','2026-08-23T10:03:22Z','paid','fulfilled',
 '066061406375','https://services.brt.it/it/tracking?OP=N&CD=066061406375','BRT',26.90,'EUR','{"demo":"true"}'),

('mirakl','02116_324862519-A','gid://shopify/Order/17710977843549','INSH6399','MediaMarktSaturn',
 'rhwipy9vt62.fznm52pke@notification.mirakl.net','2026-08-22T15:03:14Z','paid','fulfilled',
 '066061406361','https://services.brt.it/it/tracking?OP=N&CD=066061406361','BRT',19.90,'EUR','{"demo":"true"}'),

('tiktok','576940907258812630','gid://shopify/Order/17716325482845','TTOK576940907258812630',null,
 null,'2026-08-23T15:54:29Z','paid','fulfilled',
 '066061406379','https://services.brt.it/it/tracking?OP=N&CD=066061406379','BRT',14.32,'EUR','{"demo":"true"}'),

('shopify','INSH6403','gid://shopify/Order/17716349927773','INSH6403',null,
 null,'2026-08-23T16:04:18Z','paid','fulfilled',
 '066011402540','https://services.brt.it/it/tracking?OP=N&CD=066011402540','BRT',11.80,'EUR','{"demo":"true"}'),

('shopify','INSH6398','gid://shopify/Order/17710715502941','INSH6398',null,
 null,'2026-08-22T13:31:45Z','paid','unfulfilled',
 null,null,null,69.80,'EUR','{"demo":"true"}'),

-- Ordine Amazon reale, preso dalla casella (nessun ordine Amazon è ancora
-- sincronizzato su Shopify: serve a far esistere il canale amazon).
('amazon','408-6204361-9405169',null,'AMZ408-6204361-9405169',null,
 'vv13fhzpkgwqf8c@marketplace.amazon.it','2026-08-12T09:20:00Z','paid','fulfilled',
 '066061406300','https://services.brt.it/it/tracking?OP=N&CD=066061406300','BRT',34.90,'EUR','{"demo":"true"}');

-- =====================================================================
-- RIGHE ORDINE
-- =====================================================================

insert into order_line (order_id, sku, titolo, quantita, prezzo, image_url, raw)
select o.id, v.sku, v.titolo, v.qta, v.prezzo, v.img, '{"demo":"true"}'::jsonb
from (values
 ('02116_325104572-A','INN-505NEWIS','Innoliving Ventilatore Box Rotante 360° griglia frontale 3 velocità INN-505',1,24.90,'https://cdn.shopify.com/s/files/1/0665/6095/0522/files/INN-505NEWventilatorebox_logo.jpg?v=1711727273'),
 ('02116_324918498-A','INN-748IS','Innoliving Piastra elettrica doppia per cucinare 5 livelli 2000W INN-748',1,26.90,'https://cdn.shopify.com/s/files/1/0665/6095/0522/products/NORMALE_153.png?v=1738660659'),
 ('02116_324862519-A','INN-526BIS','Innoliving Ventilatore 15cm con Supporto Pieghevole Ricaricabile e Clip INN-526',1,19.90,'https://cdn.shopify.com/s/files/1/0665/6095/0522/files/INN-526B.png?v=1717169345'),
 ('576940907258812630','INN-804IS','Innoliving Specchio Ingranditore Luminoso con Ventosa INN-804',1,14.32,'https://cdn.shopify.com/s/files/1/0665/6095/0522/products/normale_7.png?v=1711726904'),
 ('INSH6403','INN-65101SR','Innoliving Filtro Hepa per Aspirapolvere INN-651',1,8.90,'https://cdn.shopify.com/s/files/1/0665/6095/0522/products/Filtro_INN-651.png?v=1666345948'),
 ('INSH6398','INN-087SR','Innoliving Racchetta Antizanzare INN-087 Colore Rosso',1,9.90,'https://cdn.shopify.com/s/files/1/0665/6095/0522/products/418PTQE7KaL._AC.jpg?v=1666618638'),
 ('INSH6398','INN-55704IS','Innoliving Filtro Hepa 13 per Purificatore Ercole Ultra INN-557',1,59.90,'https://cdn.shopify.com/s/files/1/0665/6095/0522/products/normale_48.png?v=1711727186'),
 ('408-6204361-9405169','INN-679IS','Innoliving Ferro da stiro a vapore INN-679',1,34.90,null)
) as v(ext, sku, titolo, qta, prezzo, img)
join "order" o on o.external_order_id = v.ext;

-- =====================================================================
-- IDENTITÀ DI CANALE
-- =====================================================================

insert into channel_identity (account_id, external_id, display_name)
select (select id from channel_account where code='mirakl-mms'), v.ext, v.nome
from (values
 ('rk0idlx32ez.fznm52pke@notification.mirakl.net','Clotilde Messina'),
 ('rnrg0za9bin.fznm52pke@notification.mirakl.net','Rosa Testa'),
 ('rhwipy9vt62.fznm52pke@notification.mirakl.net','Norma Fois')
) as v(ext, nome);

insert into channel_identity (account_id, external_id, display_name)
values ((select id from channel_account where code='amazon-it'),
        'vv13fhzpkgwqf8c@marketplace.amazon.it','Alessandra');

-- =====================================================================
-- CONVERSAZIONI
-- Le scadenze sono relative a now(): una scaduta, due vicine, il resto larghe.
-- =====================================================================

insert into thread (account_id, external_thread_id, order_id, identity_id, subject, state,
                    first_inbound_at, last_inbound_at, due_at, tags)
select ca.id, v.ext_thread,
       (select id from "order" where external_order_id = v.ord),
       (select id from channel_identity where external_id = v.alias),
       v.subject, v.stato,
       now() - v.eta, now() - v.eta, now() + v.scadenza,
       array['demo', v.intento]
from (values
 ('amazon-it','AMZ-T-0001','408-6204361-9405169','vv13fhzpkgwqf8c@marketplace.amazon.it',
  'Articolo danneggiato o difettoso: richiesta di sostituzione','open',
  interval '16 hours', interval '8 hours','garanzia'),

 ('mirakl-mms','MMS-T-0001','02116_324918498-A','rnrg0za9bin.fznm52pke@notification.mirakl.net',
  'Richiesta informazioni sul prodotto ricevuto','open',
  interval '27 hours', interval '-3 hours','prodotto_non_funzionante'),

 ('mirakl-mms','MMS-T-0002','02116_325104572-A','rk0idlx32ez.fznm52pke@notification.mirakl.net',
  'Richiesta sullo stato della consegna','new',
  interval '6 hours', interval '18 hours','dove_pacco'),

 ('mirakl-mms','MMS-T-0003','02116_324862519-A','rhwipy9vt62.fznm52pke@notification.mirakl.net',
  'Richiesta di reso','open',
  interval '30 hours', interval '-6 hours','reso_richiesta'),

 ('shopify-web','WEB-T-0001','INSH6403',null,
  'Richiesta fattura','new',
  interval '2 hours', interval '22 hours','fattura'),

 ('shopify-web','WEB-T-0002','INSH6398',null,
  'Ordine non ancora arrivato','open',
  interval '20 hours', interval '4 hours','dove_pacco')
) as v(canale, ext_thread, ord, alias, subject, stato, eta, scadenza, intento)
join channel_account ca on ca.code = v.canale;

-- Thread senza ordine agganciato: alimenta la vista "Da smistare".
insert into thread (account_id, external_thread_id, subject, state,
                    first_inbound_at, last_inbound_at, due_at, tags)
select id, 'AMZ-T-0002',
       'Domanda del cliente Amazon relativa ad un ordine','unmatched',
       now() - interval '3 hours', now() - interval '3 hours', now() + interval '21 hours',
       array['demo','da_classificare']
from channel_account where code='amazon-it';

-- =====================================================================
-- MESSAGGI
-- =====================================================================

insert into message (thread_id, direction, author_kind, external_id, body_text, sent_at, delivery_state, match_strategy, raw)
select t.id, v.dir, v.autore, v.ext, v.testo, now() - v.eta, 'received', v.strategia, '{"demo":"true"}'::jsonb
from (values
 ('AMZ-T-0001','in','customer','m-1','Il ferro è difettato non esce il vapore e mi si riscalda', interval '7 days','ordine_da_oggetto'),
 ('AMZ-T-0001','in','customer','m-2','Salve, ho questo prodotto da qualche mese. Improvvisamente non si riscalda più la piastra. Si accende la luce blu, poi si spegne. Non mi esce più il vapore. Vorrei esserlo cambiata.', interval '5 days','in_reply_to'),
 ('AMZ-T-0001','in','customer','m-3','Salve siccome ho la garanzia e il prodotto è difettoso vorrei che me lo cambiaste possibilmente', interval '8 hours','in_reply_to'),

 ('MMS-T-0001','in','customer','m-4','Buongiorno, ho ricevuto la piastra ma una delle due zone non scalda. L''ho provata su due prese diverse. Come posso fare?', interval '27 hours','ordine_da_payload'),

 ('MMS-T-0002','in','customer','m-5','Buonasera, volevo sapere quando parte il mio ordine. Mi serve per il fine settimana, è ancora possibile?', interval '6 hours','ordine_da_payload'),

 ('MMS-T-0003','in','customer','m-6','Vorrei restituire il ventilatore, è più piccolo di quanto pensassi. Non l''ho tolto dalla confezione. Come procedo?', interval '30 hours','ordine_da_payload'),

 ('WEB-T-0001','in','customer','m-7','Buongiorno, avrei bisogno della fattura intestata alla mia ditta per l''ordine di ieri. Grazie', interval '2 hours','email_cliente'),

 ('WEB-T-0002','in','customer','m-8','Buongiorno, il tracking risulta fermo da tre giorni allo stesso punto. L''ordine era per un regalo, sono un po'' in ansia', interval '20 hours','email_cliente'),
 ('WEB-T-0002','out','agent','m-9','Buongiorno Daniele, abbiamo aperto una segnalazione al corriere e le facciamo sapere entro domani. Ci scusiamo per l''attesa.', interval '18 hours',null),
 ('WEB-T-0002','in','customer','m-10','Grazie, resto in attesa', interval '4 hours','in_reply_to'),

 ('AMZ-T-0002','in','customer','m-11','Buongiorno, ho un problema con un prodotto acquistato il mese scorso ma non trovo più il numero d''ordine. Potete aiutarmi?', interval '3 hours',null)
) as v(thread_ext, dir, autore, ext, testo, eta, strategia)
join thread t on t.external_thread_id = v.thread_ext;

-- =====================================================================
-- TEMPLATE DI ESEMPIO
-- =====================================================================

insert into template (name, locale, allowed_kinds, subject_tpl, body_tpl, requires_review) values
('Tracking in ritardo','it', array['amazon','mirakl','tiktok','shopify'], null,
 'Buongiorno {{cliente.nome}}, abbiamo verificato la spedizione {{ordine.tracking}} e risulta in ritardo presso il corriere. Abbiamo aperto una segnalazione e le daremo un aggiornamento entro 48 ore.', false),
('Istruzioni reso','it', array['mirakl','tiktok','shopify'], null,
 'Buongiorno {{cliente.nome}}, per il reso dell''ordine {{ordine.numero}} le alleghiamo l''etichetta prepagata. Le chiediamo di reimballare il prodotto nella confezione originale.', false),
('Richiesta foto danno','it', array['amazon','mirakl','tiktok','shopify'], null,
 'Buongiorno {{cliente.nome}}, per procedere le chiediamo tre foto: il prodotto che mostri il difetto, l''imballo esterno come le è arrivato, e l''etichetta di spedizione. Appena le riceviamo procediamo subito.', false)
on conflict do nothing;

commit;

-- =====================================================================
-- VERIFICA
-- =====================================================================
select 'ordini' as cosa, count(*)::text as quanti from "order"
union all select 'righe ordine', count(*)::text from order_line
union all select 'conversazioni', count(*)::text from thread
union all select 'messaggi', count(*)::text from message
union all select 'da smistare', count(*)::text from thread where state='unmatched'
union all select 'scadute', count(*)::text from thread where due_at < now() and state <> 'closed';
