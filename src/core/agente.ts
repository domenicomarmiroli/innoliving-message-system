import type { Config } from '../config.js'
import type { Db } from '../db/index.js'

/**
 * Chi è l'agente dietro un token di sessione Lovable.
 *
 * Niente segreto condiviso col browser: il worker chiede a Supabase Auth
 * di chi è il token (SUPABASE_URL + SUPABASE_ANON_KEY, gli stessi valori
 * — non sensibili — già nel bundle dell'interfaccia), poi verifica che
 * quell'utente abbia una riga attiva in `agent`. Un token valido ma di un
 * utente senza riga in agent (o disattivato) non autorizza nulla: la
 * riga in agent è il permesso, non solo il login.
 */
export interface AgenteAutenticato {
  id: string
  nome: string
  ruolo: string
}

export async function verificaAgente(
  db: Db,
  config: Config,
  token: string,
): Promise<AgenteAutenticato | null> {
  if (!config.SUPABASE_URL || !config.SUPABASE_ANON_KEY) return null

  const risposta = await fetch(`${config.SUPABASE_URL}/auth/v1/user`, {
    headers: {
      Authorization: `Bearer ${token}`,
      apikey: config.SUPABASE_ANON_KEY,
    },
  })
  if (!risposta.ok) return null

  const utente = (await risposta.json()) as { id?: unknown }
  if (typeof utente.id !== 'string' || !utente.id) return null

  const [agente] = await db<{ id: string; nome: string; ruolo: string }[]>`
    select id, nome, ruolo from agent where user_id = ${utente.id} and active = true
  `
  return agente ?? null
}
