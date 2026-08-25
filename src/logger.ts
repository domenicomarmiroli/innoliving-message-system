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

export type Logger = typeof logger
