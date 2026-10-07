import { describe, it, expect } from 'vitest'

import { sembraNewsletter } from '../src/core/ai/traduzione.js'

describe('newsletter escluse dalla traduzione', () => {
  it('riconosce l’invito a disiscriversi in più lingue', () => {
    expect(sembraNewsletter('Hi there, your account is live. Unsubscribe here')).toBe(true)
    expect(sembraNewsletter('Clicca qui per disiscriverti')).toBe(true)
    expect(sembraNewsletter('Newsletter abbestellen')).toBe(true)
    expect(sembraNewsletter('Se désinscrire de la liste')).toBe(true)
  })
  it('lascia passare un cliente vero', () => {
    expect(sembraNewsletter('Hello, my heater arrived broken, order 405-0668977-2033157. Can you help?')).toBe(false)
    expect(sembraNewsletter('Guten Tag, das Gerät funktioniert nicht.')).toBe(false)
  })
})
