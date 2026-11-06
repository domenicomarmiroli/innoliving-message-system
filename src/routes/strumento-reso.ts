import type { FastifyInstance } from 'fastify'

import type { Config } from '../config.js'

/**
 * GET /strumenti/reso
 *
 * Schermata ad hoc per l'etichetta di reso da numero d'ordine, servita dal
 * worker stesso (nessun deploy di Lovable): login con lo stesso utente
 * dell'Hub, numero ordine e tipologia, poi PDF da scaricare e testo del
 * messaggio da copiare. Chiama POST /threads/etichetta-reso-ordine con il
 * token di sessione, quindi vale lo stesso permesso (riga attiva in `agent`).
 *
 * La pagina contiene solo URL e chiave anonima di Supabase, gli stessi
 * valori non sensibili già nel bundle dell'interfaccia. Nessun segreto.
 */

function paginaHtml(supabaseUrl: string, anonKey: string): string {
  // JSON dentro <script>: si neutralizza "<" così nessun valore può chiudere il tag.
  const cfg = JSON.stringify({ url: supabaseUrl, key: anonKey }).replace(/</g, '\\u003c')
  return `<!doctype html>
<html lang="it">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>Etichetta di reso</title>
<style>
  :root { --bg:#f6f7f9; --card:#fff; --ink:#1b2430; --mute:#5d6b7c; --line:#d9dee5; --brand:#0f5fa8; --ok:#1a7f4b; --err:#b3261e; }
  @media (prefers-color-scheme: dark) { :root { --bg:#14181d; --card:#1d232b; --ink:#e8ecf1; --mute:#9aa7b6; --line:#2e3742; --brand:#5aa9ec; --ok:#4cc38a; --err:#ff8a80; } }
  * { box-sizing: border-box; }
  body { margin:0; background:var(--bg); color:var(--ink); font:15px/1.5 system-ui,-apple-system,"Segoe UI",sans-serif; }
  main { max-width:720px; margin:0 auto; padding:24px 16px 64px; }
  h1 { font-size:22px; margin:0 0 4px; }
  p.sub { color:var(--mute); margin:0 0 20px; }
  .card { background:var(--card); border:1px solid var(--line); border-radius:10px; padding:18px; margin-bottom:16px; }
  label { display:block; font-weight:600; margin:12px 0 4px; }
  label:first-child { margin-top:0; }
  input, select, textarea { width:100%; padding:10px 12px; border:1px solid var(--line); border-radius:8px; background:var(--bg); color:var(--ink); font:inherit; }
  textarea { min-height:300px; resize:vertical; }
  button, a.btn { display:inline-block; padding:10px 16px; border:0; border-radius:8px; background:var(--brand); color:#fff; font:inherit; font-weight:600; cursor:pointer; text-decoration:none; }
  button.sec { background:transparent; color:var(--brand); border:1px solid var(--brand); }
  button:disabled { opacity:.6; cursor:wait; }
  .row { display:flex; gap:10px; flex-wrap:wrap; margin-top:14px; align-items:center; }
  .msg { margin-top:12px; font-weight:600; }
  .msg.err { color:var(--err); } .msg.ok { color:var(--ok); }
  .hint { color:var(--mute); font-size:13px; margin-top:4px; }
  [hidden] { display:none !important; }
</style>
</head>
<body>
<main>
  <h1>Etichetta di reso</h1>
  <p class="sub">Dal numero d'ordine: PDF con l'etichetta BRT e testo del messaggio da incollare.</p>

  <section id="login" class="card" hidden>
    <label for="email">Email dell'Hub</label>
    <input id="email" type="email" autocomplete="username">
    <label for="password">Password</label>
    <input id="password" type="password" autocomplete="current-password">
    <div class="row"><button id="entra">Entra</button></div>
    <div id="loginMsg" class="msg err" role="alert"></div>
  </section>

  <section id="form" class="card" hidden>
    <label for="numero">Numero ordine</label>
    <input id="numero" autocomplete="off" placeholder="es. 404-1234567-1234567 oppure #1087">
    <label for="tipo">Casistica</label>
    <select id="tipo">
      <option value="verificare">Verificare prodotto (spedizione a nostro carico)</option>
      <option value="danneggiato">Prodotto danneggiato (spedizione a nostro carico)</option>
      <option value="recesso">Recesso prodotto nuovo (6,00 € trattenuti dal rimborso)</option>
    </select>
    <div id="extra" hidden>
      <label for="canale">Canale</label>
      <input id="canale" autocomplete="off" placeholder="es. bricobravo">
      <label for="nome">Nome del cliente</label>
      <input id="nome" autocomplete="off">
      <div class="hint">L'ordine non è nell'Hub: servono canale e nome.</div>
    </div>
    <div class="row">
      <button id="genera">Genera etichetta</button>
      <button id="esci" class="sec" type="button">Esci</button>
    </div>
    <div id="formMsg" class="msg" role="status"></div>
  </section>

  <section id="risultato" class="card" hidden>
    <div class="row" style="margin-top:0">
      <a id="scarica" class="btn" href="#" target="_blank" rel="noopener">Scarica il PDF</a>
      <span id="info" class="hint"></span>
    </div>
    <div id="blocco">
      <label for="oggetto">Oggetto</label>
      <input id="oggetto" readonly>
      <label for="testo">Testo del messaggio</label>
      <textarea id="testo" readonly></textarea>
      <div class="row">
        <button id="copiaTesto">Copia testo</button>
        <button id="copiaOggetto" class="sec">Copia oggetto</button>
        <span id="copiato" class="msg ok" style="margin:0"></span>
      </div>
    </div>
    <div id="senzaTesto" class="msg err" hidden></div>
  </section>
</main>
<script>
const CFG = ${cfg};
const $ = (id) => document.getElementById(id);
const CHIAVE = 'reso_token';
let token = null;
try { token = sessionStorage.getItem(CHIAVE); } catch (e) {}

function mostra(login) {
  $('login').hidden = !login;
  $('form').hidden = login;
  if (login) $('risultato').hidden = true;
}
mostra(!token);

$('entra').onclick = async () => {
  $('loginMsg').textContent = '';
  $('entra').disabled = true;
  try {
    const r = await fetch(CFG.url + '/auth/v1/token?grant_type=password', {
      method: 'POST',
      headers: { apikey: CFG.key, 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: $('email').value.trim(), password: $('password').value }),
    });
    const j = await r.json().catch(() => ({}));
    if (!r.ok || !j.access_token) throw new Error('Email o password non corrette.');
    token = j.access_token;
    try { sessionStorage.setItem(CHIAVE, token); } catch (e) {}
    $('password').value = '';
    mostra(false);
  } catch (e) {
    $('loginMsg').textContent = e.message;
  } finally { $('entra').disabled = false; }
};

$('esci').onclick = () => {
  token = null;
  try { sessionStorage.removeItem(CHIAVE); } catch (e) {}
  mostra(true);
};

function messaggio(testo, classe) {
  const m = $('formMsg');
  m.textContent = testo;
  m.className = 'msg' + (classe ? ' ' + classe : '');
}

$('genera').onclick = async () => {
  const numero = $('numero').value.trim();
  if (!numero) { messaggio('Scrivi il numero ordine.', 'err'); return; }
  const corpo = { numero_ordine: numero, tipo: $('tipo').value };
  if (!$('extra').hidden) {
    corpo.canale = $('canale').value.trim();
    corpo.nome_cliente = $('nome').value.trim();
  }
  $('genera').disabled = true;
  $('risultato').hidden = true;
  messaggio('Sto generando l\\'etichetta...', '');
  try {
    const r = await fetch('/threads/etichetta-reso-ordine', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token },
      body: JSON.stringify(corpo),
    });
    const j = await r.json().catch(() => ({}));
    if (r.status === 401) { messaggio('', ''); $('esci').click(); $('loginMsg').textContent = 'Sessione scaduta: rientra.'; return; }
    if (r.status === 422 && /non trovato/.test(j.errore || '')) {
      $('extra').hidden = false;
      messaggio(j.errore, 'err');
      return;
    }
    if (!r.ok) { messaggio(j.errore || 'Errore imprevisto.', 'err'); return; }
    messaggio('Etichetta pronta.', 'ok');
    mostraRisultato(j);
  } catch (e) {
    messaggio('Il server non risponde: riprova fra poco.', 'err');
  } finally { $('genera').disabled = false; }
};

function mostraRisultato(j) {
  $('scarica').href = j.url_download;
  $('scarica').textContent = 'Scarica il PDF';
  $('info').textContent = j.nome_file + (j.gia_esistente ? ' · già generata prima: stessa etichetta, nessuna nuova spedizione' : '');
  const m = j.messaggio;
  $('blocco').hidden = !m;
  $('senzaTesto').hidden = !!m;
  if (m) {
    $('oggetto').value = m.oggetto || '';
    $('oggetto').parentElement.querySelector('label[for="oggetto"]').hidden = !m.oggetto;
    $('oggetto').hidden = !m.oggetto;
    $('copiaOggetto').hidden = !m.oggetto;
    $('testo').value = m.testo;
  } else {
    $('senzaTesto').textContent = 'Modello di testo non trovato nel database: scarica il PDF e scrivi a mano.';
  }
  $('copiato').textContent = '';
  $('risultato').hidden = false;
  $('risultato').scrollIntoView({ behavior: 'smooth', block: 'start' });
}

async function copia(testo, cosa) {
  try {
    await navigator.clipboard.writeText(testo);
  } catch (e) {
    const t = document.createElement('textarea');
    t.value = testo; document.body.appendChild(t); t.select();
    document.execCommand('copy'); t.remove();
  }
  $('copiato').textContent = cosa + ' copiato';
  setTimeout(() => { $('copiato').textContent = ''; }, 2500);
}
$('copiaTesto').onclick = () => copia($('testo').value, 'Testo');
$('copiaOggetto').onclick = () => copia($('oggetto').value, 'Oggetto');
$('numero').addEventListener('keydown', (e) => { if (e.key === 'Enter') $('genera').click(); });
</script>
</body>
</html>`
}

export async function strumentoResoRoutes(app: FastifyInstance, opts: { config: Config }) {
  const { config } = opts
  if (!config.SUPABASE_URL || !config.SUPABASE_ANON_KEY) return
  const html = paginaHtml(config.SUPABASE_URL, config.SUPABASE_ANON_KEY)
  app.get('/strumenti/reso', async (_req, reply) => {
    return reply
      .header('Cache-Control', 'no-store')
      .header('X-Robots-Tag', 'noindex')
      .type('text/html; charset=utf-8')
      .send(html)
  })
}
