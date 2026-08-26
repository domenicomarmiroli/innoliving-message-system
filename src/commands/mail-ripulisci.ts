/**
 * Ripulisce il corpo dei messaggi già importati.
 *
 *   npm run mail:ripulisci -- --prova     mostra cosa cambierebbe
 *   npm run mail:ripulisci                riscrive
 *
 * È il motivo per cui conserviamo `raw` (regola 4): il testo integrale
 * è ancora lì, quindi la pulizia si può rifare quante volte serve, anche
 * dopo aver migliorato le regole. Nessuna informazione va persa: si
 * riscrive solo `body_text`, cioè la versione che si legge.
 */
import { loadConfig } from '../config.js'
import { createDb } from '../db/index.js'
import { caricaRegole } from '../connectors/mail/regole.js'
import { ripulisci } from '../connectors/mail/ripulisci.js'
import { regoleDaConfig } from '../connectors/mail/ripulisci.js'

const prova = process.argv.includes('--prova')
const config = loadConfig()
const db = createDb(config)

try {
  const { regole, casella } = await caricaRegole(db)
  const perAccount = new Map(
    [...regole, casella].map((r) => [r.account_id, r.testo]),
  )
  const predefinite = regoleDaConfig({})

  const righe = await db<
    { id: string; account_id: string; body_text: string | null; raw: { body_text?: string } }[]
  >`
    select m.id, t.account_id, m.body_text, m.raw
    from message m
    join thread t on t.id = m.thread_id
    where m.direction = 'in'
    order by m.sent_at
  `

  let cambiati = 0
  let invariati = 0
  const esempi: Array<{ prima: number; dopo: number; testo: string }> = []

  for (const r of righe) {
    // Si riparte SEMPRE dal grezzo, non dal body_text già scritto:
    // ripulire due volte un testo già ripulito darebbe risultati diversi.
    const integrale = r.raw?.body_text ?? null
    if (!integrale) {
      invariati += 1
      continue
    }

    const pulito = ripulisci(integrale, perAccount.get(r.account_id) ?? predefinite)
    if (pulito === r.body_text) {
      invariati += 1
      continue
    }

    cambiati += 1
    if (esempi.length < 3 && pulito) {
      esempi.push({ prima: integrale.length, dopo: pulito.length, testo: pulito })
    }
    if (!prova) {
      await db`update message set body_text = ${pulito}, updated_at = now() where id = ${r.id}`
    }
  }

  console.log('')
  console.log(`  messaggi esaminati: ${righe.length}`)
  console.log(`  da riscrivere:      ${cambiati}`)
  console.log(`  già a posto:        ${invariati}`)
  console.log('')
  for (const e of esempi) {
    const testo = e.testo.length > 120 ? e.testo.slice(0, 120) + '…' : e.testo
    console.log(`  ${e.prima} caratteri → ${e.dopo}:  ${testo.replace(/\n/g, ' ⏎ ')}`)
  }
  console.log('')
  if (prova) console.log('  (prova: non ho scritto niente. Rilancia senza --prova.)\n')
} finally {
  await db.end({ timeout: 5 })
}
