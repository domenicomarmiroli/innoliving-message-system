/**
 * Classifica l'intento dei ticket già esistenti senza nessun tag —
 * lanciato a mano, una tantum. Non gira da solo: sono centinaia di
 * chiamate AI, un costo e un tempo reali.
 *
 *   npm run intento:backfill -- --limite 20
 *
 * Senza --limite processa tutti i thread senza tag. Un ritardo fra una
 * chiamata e l'altra evita di saturare l'API del provider.
 */
import { loadConfig } from '../config.js'
import { createDb } from '../db/index.js'
import { logger } from '../logger.js'
import { classificaEsalvaIntento } from '../core/ai/intento.js'

const ATTESA_MS = 400

function leggiLimite(argv: string[]): number | null {
  const idx = argv.indexOf('--limite')
  if (idx === -1) return null
  const valore = Number(argv[idx + 1])
  return Number.isFinite(valore) && valore > 0 ? Math.floor(valore) : null
}

const config = loadConfig()
const db = createDb(config)
const limite = leggiLimite(process.argv)
// Nessun --limite: un tetto alto ma finito, così la query resta sempre nella stessa forma.
const tetto = limite ?? 100_000

try {
  const thread = await db<{ id: string; primo_testo: string }[]>`
    select t.id, m.body_text as primo_testo
    from thread t
    join lateral (
      select body_text
      from message
      where thread_id = t.id and direction = 'in' and author_kind = 'customer'
        and body_text is not null and body_text <> ''
      order by sent_at asc
      limit 1
    ) m on true
    where t.tags = '{}'::text[] or t.tags is null
    order by t.created_at asc
    limit ${tetto}
  `

  console.log(`Thread da classificare: ${thread.length}`)
  if (limite) console.log(`(limitato a --limite ${limite})`)
  console.log('')

  let fatti = 0
  let falliti = 0
  for (const t of thread) {
    try {
      await classificaEsalvaIntento(db, logger, config, t.id, t.primo_testo)
      fatti += 1
    } catch {
      // classificaEsalvaIntento non lancia mai: un errore qui sarebbe
      // imprevisto, ma non deve fermare il resto del giro.
      falliti += 1
    }
    if (fatti % 50 === 0) console.log(`  ...${fatti}/${thread.length}`)
    await new Promise((r) => setTimeout(r, ATTESA_MS))
  }

  console.log('')
  console.log(`Fatto: ${fatti} classificati, ${falliti} falliti.`)
  console.log('Controlla in Supabase con: select tags, count(*) from thread group by tags order by 2 desc limit 20;')
} finally {
  await db.end({ timeout: 5 })
}
