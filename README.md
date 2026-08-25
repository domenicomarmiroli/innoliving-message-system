# Hub Messaggi — worker

Servizio di ingestion e invio per la piattaforma di assistenza multicanale.
L'interfaccia è un progetto Lovable separato che legge lo stesso database.

## Avvio locale

```bash
npm install
cp .env.example .env      # e compila almeno SUPABASE_DB_URL
npm run dev
curl localhost:3000/health
```

`/health` esegue un `select 1` sul database: risponde 200 se la connessione
funziona, 503 con l'errore in chiaro se non funziona.

## Dove prendere SUPABASE_DB_URL

Nel progetto Lovable, dalle impostazioni del database (Supabase), scegli la
stringa del **Session pooler**, quella che comincia con
`postgresql://postgres.<ref>@aws-<region>.pooler.supabase.com:5432`.

Non usare la connessione diretta `db.<ref>.supabase.co`: è IPv6-only e Render
non la raggiunge.

## Deploy su Render

`render.yaml` è già pronto. Piano `starter`, non free: il free va in sleep e
fa perdere i webhook. Le variabili d'ambiente vanno inserite a mano nel
pannello Render (`sync: false` significa esattamente questo).

## Convenzioni

Le regole di sviluppo stanno in `CLAUDE.md` e valgono sia per le persone sia
per gli agenti. Le due che si dimenticano più spesso:

- lo schema del database **non** si tocca da qui, è di proprietà di Lovable;
- niente valori specifici dell'azienda nel codice — c'è un test che lo verifica.
