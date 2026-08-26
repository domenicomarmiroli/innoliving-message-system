import type { Db } from '../../db/index.js'
import { regoleDaConfig } from './ripulisci.js'
import type { OpzioniIngest, RegolaCanale } from './tipi.js'

/**
 * Le regole di riconoscimento vivono nel database, non nel codice
 * (regola 7 di CLAUDE.md): aggiungere un marketplace è una riga di SQL.
 */

interface RigaAccount {
  id: string
  code: string
  kind: RegolaCanale['kind']
  config: Record<string, unknown> | null
}

function domini(config: RigaAccount['config']): string[] {
  const v = config?.sender_domains
  if (!Array.isArray(v)) return []
  return v.filter((x): x is string => typeof x === 'string' && x.length > 0)
}

const OPZIONI_PREDEFINITE: OpzioniIngest = {
  // Vuota per scelta: senza configurazione entra tutto. Il default
  // prudente qui è "non perdere niente", non "filtrare bene".
  domini_esclusi: [],
  domini_notifica: [],
  giorni_coda: 7,
}

export interface Regole {
  regole: RegolaCanale[]
  casella: RegolaCanale
  opzioni: OpzioniIngest
}

export async function caricaRegole(db: Db): Promise<Regole> {
  const righe = await db<RigaAccount[]>`
    select id, code, kind, config
    from channel_account
    where active
    order by kind, code
  `

  const tutte: RegolaCanale[] = righe.map((r) => ({
    account_id: r.id,
    code: r.code,
    kind: r.kind,
    sender_domains: domini(r.config),
    order_id_pattern:
      typeof r.config?.order_id_pattern === 'string'
        ? (r.config.order_id_pattern as string)
        : null,
    testo: regoleDaConfig(r.config),
  }))

  const casella = tutte.find((r) => r.kind === 'email')
  if (!casella) {
    throw new Error(
      "Manca l'account della casella (kind='email') in channel_account. " +
        'Applica la migrazione db/migrations/0002_mail_routing.sql.',
    )
  }

  const [conf] = await db<{ value: Record<string, unknown> }[]>`
    select value from app_config where key = 'mail_ingest'
  `

  const opzioni: OpzioniIngest = {
    domini_esclusi: Array.isArray(conf?.value?.domini_esclusi)
      ? (conf.value.domini_esclusi as unknown[]).filter(
          (x): x is string => typeof x === 'string' && x.length > 0,
        )
      : OPZIONI_PREDEFINITE.domini_esclusi,
    domini_notifica: Array.isArray(conf?.value?.domini_notifica)
      ? (conf.value.domini_notifica as unknown[]).filter(
          (x): x is string => typeof x === 'string' && x.length > 0,
        )
      : OPZIONI_PREDEFINITE.domini_notifica,
    giorni_coda:
      typeof conf?.value?.giorni_coda === 'number' && conf.value.giorni_coda >= 0
        ? (conf.value.giorni_coda as number)
        : OPZIONI_PREDEFINITE.giorni_coda,
  }

  // La casella non è un canale di provenienza: è il contenitore di ciò
  // che non riconosciamo. Escluderla evita che si riconosca da sola.
  return { regole: tutte.filter((r) => r.kind !== 'email'), casella, opzioni }
}
