import postgres from 'postgres'
import type { Config } from '../config.js'

/**
 * Connessione al database.
 *
 * IMPORTANTE: SUPABASE_DB_URL deve puntare al Supavisor shared pooler in
 * session mode (aws-<region>.pooler.supabase.com, porta 5432).
 * La connessione diretta db.<ref>.supabase.co è IPv6-only e Render non la
 * raggiunge.
 */
export function createDb(config: Config) {
  return postgres(config.SUPABASE_DB_URL, {
    max: 10,
    idle_timeout: 30,
    connect_timeout: 10,
    prepare: false, // richiesto dal pooler in transaction mode
    onnotice: () => {},
  })
}

export type Db = ReturnType<typeof createDb>
