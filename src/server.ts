import Fastify from 'fastify'
import cors from '@fastify/cors'
import { randomUUID } from 'node:crypto'
import type { Config } from './config.js'
import { logger } from './logger.js'
import { createDb } from './db/index.js'
import { impostaMisuraAI } from './core/ai/consumo.js'
import { healthRoutes } from './routes/health.js'
import { replyRoutes } from './routes/reply.js'
import { collegaRoutes } from './routes/collega.js'
import { draftRoutes } from './routes/draft.js'
import { traduzioneRoutes } from './routes/traduzione.js'
import { knowledgeRoutes } from './routes/knowledge.js'
import { contattiRoutes } from './routes/contatti.js'
import { clientiRoutes } from './routes/clienti.js'
import { voceRoutes } from './routes/voce.js'
import { richiamaRoutes } from './routes/richiama.js'
import { avviaRichiamate } from './connectors/voce/richiamate.js'
import { voceWebhookRoutes } from './routes/voce-webhook.js'
import { shopifyWebhookRoutes } from './routes/webhooks-shopify.js'
import { avviaPolling } from './connectors/mail/poll.js'
import { avviaPollingGraph } from './connectors/graph/poll.js'
import { avviaAllineamentoOrdini } from './connectors/shopify/periodico.js'
import { avviaControlloRientri } from './connectors/magazzino/periodico.js'
import { avviaTrackingBrt } from './connectors/brt/periodico.js'

export async function buildServer(config: Config) {
  const app = Fastify({
    loggerInstance: logger,
    genReqId: () => randomUUID(),
    // I webhook di Shopify richiedono il corpo grezzo per la verifica HMAC.
    bodyLimit: 8 * 1024 * 1024,
  })

  // Senza questo, il browser di Lovable blocca la richiesta prima ancora
  // che arrivi al server: niente log qui, solo un errore di rete lato
  // interfaccia. Elenco esplicito di origini, mai un jolly — sono
  // rotte che accettano una sessione agente autenticata.
  if (config.INTERFACCIA_ORIGINS) {
    const origini = config.INTERFACCIA_ORIGINS.split(',').map((o) => o.trim()).filter(Boolean)
    await app.register(cors, {
      origin: origini,
      methods: ['GET', 'POST'],
      allowedHeaders: ['Content-Type', 'Authorization', 'X-Worker-Token'],
    })
  } else {
    logger.warn(
      'INTERFACCIA_ORIGINS non impostata: le chiamate dal browser (Lovable) verranno bloccate da CORS',
    )
  }

  const db = createDb(config)
  // Ogni chiamata AI si misura in ai_uso e i lavori in background hanno
  // un tetto giornaliero (core/ai/consumo.ts).
  impostaMisuraAI(db, logger)
  await app.register(healthRoutes, { db })
  await app.register(shopifyWebhookRoutes, { db, config })
  await app.register(replyRoutes, { db, config })
  await app.register(collegaRoutes, { db, config })
  await app.register(draftRoutes, { db, config })
  await app.register(traduzioneRoutes, { db, config })
  await app.register(knowledgeRoutes, { db, config })
  await app.register(contattiRoutes, { db, config })
  await app.register(clientiRoutes, { db, config })
  // Plugin incapsulato: i suoi hook (secret obbligatorio, registro in
  // voice_log) valgono solo per le rotte /voce/*.
  await app.register(voceRoutes, { db, config })
  await app.register(richiamaRoutes, { db, config })
  // Fine chiamata: firma HMAC di ElevenLabs, fuori dal plugin degli strumenti.
  await app.register(voceWebhookRoutes, { db, config })

  // La casella si legge chiedendo, non aspettando: IMAP non ha notifiche.
  // Se le credenziali mancano il ciclo non parte e il resto funziona
  // lo stesso — il worker non deve morire perché manca un pezzo.
  const casella = avviaPolling(db, logger, config)

  // La casella aziendale su Microsoft 365, accanto a Gmail durante la
  // migrazione: ciclo separato, così un problema dell'una non ferma
  // l'altra. Senza le MS_* non parte.
  const casellaMicrosoft = avviaPollingGraph(db, logger, config)

  // Gli ordini arrivano dai webhook, che sono immediati. Questo giro è
  // la rete sotto: un webhook può perdersi durante un deploy o dopo un
  // 500, e un ordine mancante significa un cliente che scrive di un
  // ordine che per noi non esiste.
  const ordini = avviaAllineamentoOrdini(db, logger, config)

  // Rientri fisici in magazzino: un altro tool (altro progetto, altro
  // database) scansiona i resi in arrivo; questo giro scopre quando un
  // reso Amazon autorizzato è arrivato davvero e riapre il ticket.
  const rientri = avviaControlloRientri(db, logger, config)

  // Stato delle spedizioni BRT dalla pagina pubblica, una volta al giorno
  // per spedizione finché non risulta consegnata.
  const trackingBrt = avviaTrackingBrt(db, logger, config)

  // Richiamate del cliente con l'agente vocale: un giro al minuto, solo
  // nella fascia 8-21 (connectors/voce/richiamate.ts).
  const richiamate = avviaRichiamate(db, logger, config)

  app.addHook('onClose', async () => {
    casella?.ferma()
    casellaMicrosoft?.ferma()
    ordini?.ferma()
    rientri?.ferma()
    trackingBrt?.ferma()
    richiamate?.ferma()
    await db.end({ timeout: 5 })
  })

  return app
}
