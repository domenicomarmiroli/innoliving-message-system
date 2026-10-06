/**
 * Dove acquistare un prodotto, per l'agente vocale.
 *
 * I siti vengono da `app_config.voce_siti_acquisto` (migrazione 0039),
 * mai dal codice: qui c'è solo la regola. Prima il sito del marchio, poi
 * quello da indicare sempre; senza duplicati se coincidono. Ogni sito
 * porta la sua pronuncia, perché un indirizzo web letto dalla voce
 * sintetica ("bimaritaly punto it" detto lettera per lettera) non si
 * capisce.
 */

export interface SitiAcquisto {
  per_marchio?: Record<string, string>
  sempre?: string
  pronuncia?: Record<string, string>
}

export interface SitoDaDire {
  sito: string
  si_pronuncia: string
}

export function doveAcquistare(conf: SitiAcquisto | null | undefined, marchio: string | null | undefined): SitoDaDire[] {
  if (!conf) return []
  const perMarchio = conf.per_marchio ?? {}
  const chiave = marchio
    ? Object.keys(perMarchio).find((k) => k.trim().toLowerCase() === marchio.trim().toLowerCase())
    : undefined
  const siti = [chiave ? perMarchio[chiave] : undefined, conf.sempre].filter(
    (s, i, tutti): s is string => !!s && tutti.indexOf(s) === i,
  )
  return siti.map((sito) => ({ sito, si_pronuncia: conf.pronuncia?.[sito] ?? sito }))
}
