import { z } from 'zod'

/**
 * Configurazione validata all'avvio.
 * Se manca una variabile il processo esce subito dicendo QUALE:
 * scoprirlo da uno stack trace tre ore dopo il deploy costa molto di più.
 */
const schema = z.object({
  SUPABASE_DB_URL: z.string().min(1, 'stringa di connessione al database'),

  SHOPIFY_SHOP: z.string().min(1).optional(),
  SHOPIFY_ADMIN_TOKEN: z.string().min(1).optional(),
  SHOPIFY_WEBHOOK_SECRET: z.string().min(1).optional(),

  MS_TENANT_ID: z.string().min(1).optional(),
  MS_CLIENT_ID: z.string().min(1).optional(),
  MS_CLIENT_SECRET: z.string().min(1).optional(),
  MS_MAILBOX: z.string().min(1).optional(),
  MS_WEBHOOK_CLIENT_STATE: z.string().min(1).optional(),

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
