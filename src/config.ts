import { z } from 'zod'

/**
 * Configurazione validata all'avvio.
 * Se manca una variabile il processo esce subito dicendo QUALE:
 * scoprirlo da uno stack trace tre ore dopo il deploy costa molto di più.
 */
const schema = z.object({
  SUPABASE_DB_URL: z.string().min(1, 'stringa di connessione al database'),

  SHOPIFY_SHOP: z.string().min(1).optional(),
  // Due modi di autenticarsi, in ordine di precedenza:
  //  1. SHOPIFY_ADMIN_TOKEN — token statico delle vecchie app create
  //     dall'admin del negozio (shpat_...). Non più creabili da agosto 2026.
  //  2. SHOPIFY_CLIENT_ID + SHOPIFY_CLIENT_SECRET — app del Dev Dashboard:
  //     il worker si procura da solo un token valido 24 ore.
  SHOPIFY_ADMIN_TOKEN: z.string().min(1).optional(),
  SHOPIFY_CLIENT_ID: z.string().min(1).optional(),
  SHOPIFY_CLIENT_SECRET: z.string().min(1).optional(),
  // Firma dei webhook. Con un'app del Dev Dashboard è il client secret.
  SHOPIFY_WEBHOOK_SECRET: z.string().min(1).optional(),

  // --- Casella di assistenza, via IMAP/SMTP ---------------------------
  // Trasporto attuale. Microsoft Graph (le MS_* qui sotto) resta previsto
  // come sostituzione: cambia il modulo, non cambia il resto.
  MAIL_IMAP_HOST: z.string().min(1).optional(),
  MAIL_IMAP_PORT: z.coerce.number().int().positive().default(993),
  MAIL_SMTP_HOST: z.string().min(1).optional(),
  MAIL_SMTP_PORT: z.coerce.number().int().positive().default(465),
  MAIL_USER: z.string().min(1).optional(),
  // Password per app di Google: 16 caratteri. Gli spazi che Google mostra
  // sono solo grafici — li togliamo qui, così incollarla con gli spazi
  // non produce un errore di autenticazione incomprensibile.
  MAIL_PASSWORD: z
    .string()
    .min(1)
    .optional()
    .transform((v) => (v ? v.replace(/\s+/g, '') : v)),
  MAIL_POLL_SECONDS: z.coerce.number().int().positive().default(60),
  // Cartella da leggere. Su Gmail le cartelle IMAP sono le etichette.
  MAIL_FOLDER: z.string().min(1).default('INBOX'),

  // Ogni quanti minuti riallineare gli ordini con Shopify. È la rete di
  // sicurezza sotto i webhook, non il canale principale: un'ora basta.
  SHOPIFY_SYNC_MINUTES: z.coerce.number().int().positive().default(60),

  MS_TENANT_ID: z.string().min(1).optional(),
  MS_CLIENT_ID: z.string().min(1).optional(),
  MS_CLIENT_SECRET: z.string().min(1).optional(),
  MS_MAILBOX: z.string().min(1).optional(),
  MS_WEBHOOK_CLIENT_STATE: z.string().min(1).optional(),

  // Segreto condiviso che protegge gli endpoint di invio, per chiamate
  // da server a server (automazioni, non l'interfaccia). Senza NESSUNO
  // dei due meccanismi di autenticazione (questo o SUPABASE_URL +
  // SUPABASE_ANON_KEY sotto), la rotta di risposta non viene nemmeno
  // registrata: un endpoint aperto che spedisce dalla tua identità
  // venditore è troppo pericoloso per essere il comportamento predefinito.
  WORKER_API_TOKEN: z.string().min(16).optional(),

  // Per verificare la sessione di un agente loggato in Lovable: il
  // worker chiede a Supabase Auth di chi è il token, senza mai tenere un
  // segreto condiviso col browser. Stessi valori — non sensibili, sono
  // già nel bundle di Lovable — usati dall'interfaccia.
  SUPABASE_URL: z.string().url().optional(),
  SUPABASE_ANON_KEY: z.string().min(1).optional(),

  PORT: z.coerce.number().int().positive().default(3000),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace']).default('info'),
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
})

export type Config = z.infer<typeof schema>

/** Valida senza uscire dal processo: usata dai test. */
export function parseConfig(env: NodeJS.ProcessEnv = process.env) {
  return schema.safeParse(env)
}

/** Valida ed esce con un messaggio leggibile se qualcosa manca. */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const result = parseConfig(env)
  if (!result.success) {
    const righe = result.error.issues.map((i) => `  - ${i.path.join('.')}: ${i.message}`)
    console.error(
      [
        "Configurazione non valida. Variabili d'ambiente mancanti o errate:",
        ...righe,
        '',
        'Vedi .env.example.',
      ].join('\n'),
    )
    process.exit(1)
  }
  return result.data
}
