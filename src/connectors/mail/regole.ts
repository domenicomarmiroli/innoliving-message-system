import type { Db } from '../../db/index.js'
import type { RegolaCanale } from './tipi.js'

/**
 * Le regole di riconoscimento vivono nel database, non nel codice
 * (regola 7 di CLAUDE.md): aggiungere un marketplace è una riga di SQL.
 */

interface RigaAccount {
  id: string
  code: string
  kind: RegolaCanale['kind']
  config: { sender_domains?: unknown; order_id_pattern?: unknown } | null
}

function domini(config: RigaAccount['config']): string[] {
  const v = config?.sender_domains
  if (!Array.isArray(v)) return []
  return v.filter((x): x is string => typeof x === 'string' && x.length > 0)
}

export async function caricaRegole(db: Db): Promise<{
  regole: RegolaCanale[]
  casella: RegolaCanale
}> {
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
      typeof r.config?.order_id_pattern === 'string' ? r.config.order_id_pattern : null,
  }))

  const casella = tutte.find((r) => r.kind === 'email')
  if (!casella) {
    throw new Error(
      "Manca l'account della casella (kind='email') in channel_account. " +
        'Applica la migrazione db/migrations/0002_mail_routing.sql.',
    )
  }

  // La casella non è un canale di provenienza: è il contenitore di ciò
  // che non riconosciamo. Escluderla evita che si riconosca da sola.
  return { regole: tutte.filter((r) => r.kind !== 'email'), casella }
}
