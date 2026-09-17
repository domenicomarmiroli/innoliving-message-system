/**
 * Recupero degli allegati Mirakl entrati come solo metadato.
 *
 *   npm run mirakl:allegati            scarica e carica su Storage
 *   npm run mirakl:allegati -- --prova elenca soltanto, non scrive
 *   npm run mirakl:allegati -- --limite 10
 *
 * Quando il download M13 falliva, l'allegato veniva registrato lo stesso
 * ma senza file: in interfaccia si vede la riga e non si apre niente.
 * Corretto il difetto (mancava `shop_id` per gli account multi-shop), le
 * righe già scritte restano però vuote — la sincronizzazione non le
 * ripassa, perché il messaggio esiste già e l'upsert non lo tocca.
 * Questo comando le ripesca una per una.
 *
 * L'identificativo Mirakl dell'allegato è nella colonna `checksum`: per
 * una riga senza file quel campo non contiene un'impronta dei byte (che
 * non abbiamo mai avuto) ma l'id dell'allegato, ed è quello che serve a
 * M13. Le righe di altri canali hanno lì una vera impronta sha256, e
 * infatti la query prende solo i thread Mirakl.
 */
import { loadConfig } from '../config.js'
import { createDb } from '../db/index.js'
import { logger } from '../logger.js'
import { ClientMirakl, costruisciOperatori } from '../connectors/mirakl/client.js'
import { scaricaAllegatoMirakl } from '../connectors/mirakl/upsert.js'
import { storageConfigurato } from '../core/storage.js'

const prova = process.argv.includes('--prova')
const indiceLimite = process.argv.indexOf('--limite')
const limite =
  indiceLimite >= 0 ? Number(process.argv[indiceLimite + 1] ?? '50') : 50

const config = loadConfig()
const db = createDb(config)

try {
  if (!storageConfigurato(config) && !prova) {
    console.error('\nStorage non configurato: servono SUPABASE_URL e SUPABASE_SERVICE_ROLE_KEY.\n')
    process.exit(1)
  }

  const righe = await db<
    {
      id: string
      nome_file: string | null
      dimensione_byte: number | null
      checksum: string | null
      account_id: string
      code: string
      thread_id: string
    }[]
  >`
    select a.id, a.nome_file, a.dimensione_byte, a.checksum,
           ca.id as account_id, ca.code, t.id as thread_id
    from attachment a
    join message m on m.id = a.message_id
    join thread t on t.id = m.thread_id
    join channel_account ca on ca.id = t.account_id
    where a.storage_path is null
      and ca.kind = 'mirakl'
      and a.checksum is not null
    order by a.created_at desc
    limit ${limite}
  `

  if (righe.length === 0) {
    console.log('\nNessun allegato Mirakl da recuperare.\n')
    process.exit(0)
  }

  const accounts = await db<
    {
      id: string
      code: string
      display_name: string
      config: { endpoint?: unknown; shop_id?: unknown } | null
      secret_ref: string | null
    }[]
  >`
    select id, code, display_name, config, secret_ref
    from channel_account where kind = 'mirakl' and active order by code
  `
  const operatori = costruisciOperatori(accounts, process.env, logger)
  const perAccount = new Map(operatori.map((o) => [o.account_id, o]))

  console.log(`\n${righe.length} allegati senza file:\n`)
  let recuperati = 0
  let falliti = 0

  for (const r of righe) {
    const operatore = perAccount.get(r.account_id)
    if (!operatore) {
      console.log(`  ${r.code} ${r.nome_file}: operatore non configurato, saltato`)
      continue
    }
    if (prova) {
      console.log(`  ${r.code} ${r.nome_file} (${r.dimensione_byte ?? '?'} byte) id=${r.checksum}`)
      continue
    }

    const client = new ClientMirakl(operatore, logger)
    try {
      const pronto = await scaricaAllegatoMirakl(config, client, {
        external_id: r.checksum,
        nome_file: r.nome_file,
        dimensione_byte: r.dimensione_byte,
      })
      await db`
        update attachment
        set storage_path = ${pronto.storage_path},
            mime = ${pronto.mime},
            checksum = ${pronto.checksum},
            larghezza = ${pronto.larghezza},
            altezza = ${pronto.altezza}
        where id = ${r.id}
      `
      recuperati += 1
      console.log(`  ✓ ${r.code} ${r.nome_file} → ${pronto.storage_path}`)
    } catch (errore) {
      falliti += 1
      console.log(
        `  ✗ ${r.code} ${r.nome_file}: ${errore instanceof Error ? errore.message : String(errore)}`,
      )
    }
  }

  if (!prova) console.log(`\nRecuperati ${recuperati}, falliti ${falliti}.\n`)
} finally {
  await db.end()
}
