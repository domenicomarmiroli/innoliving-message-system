import pino from 'pino'

export const logger = pino({
  level: process.env.LOG_LEVEL ?? 'info',
  base: { service: 'hub-messaggi-worker' },
  // Nessun dato personale nei log: aggiungere qui ogni campo sensibile.
  redact: {
    paths: ['req.headers.authorization', 'req.headers.cookie', '*.iban', '*.secret_ref'],
    censor: '[oscurato]',
  },
})

/**
 * Interfaccia minima del logger.
 * I moduli di dominio dipendono da questa, non dal tipo concreto di pino:
 * così accettano sia il logger dell'applicazione sia quello per richiesta di
 * Fastify, che sono compatibili nell'uso ma non nel tipo.
 */
export interface Logger {
  info(obj: unknown, msg?: string): void
  warn(obj: unknown, msg?: string): void
  error(obj: unknown, msg?: string): void
  debug(obj: unknown, msg?: string): void
}
