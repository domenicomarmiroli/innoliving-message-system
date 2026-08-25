import { loadConfig } from './config.js'
import { buildServer } from './server.js'

const config = loadConfig()
const app = await buildServer(config)

try {
  await app.listen({ port: config.PORT, host: '0.0.0.0' })
} catch (err) {
  app.log.error({ err }, 'avvio fallito')
  process.exit(1)
}

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    app.log.info({ signal }, 'arresto in corso')
    void app.close().then(() => process.exit(0))
  })
}
