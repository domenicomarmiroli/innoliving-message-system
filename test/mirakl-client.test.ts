import { describe, it, expect, vi, afterEach } from 'vitest'
import { ClientMirakl } from '../src/connectors/mirakl/client.js'
import { logger } from '../src/logger.js'

const operatore = {
  account_id: 'acc-1',
  code: 'test-op',
  display_name: 'Operatore di prova',
  endpoint: 'https://esempio.mirakl.net',
  chiave: 'chiave-segreta',
  shop_id: null,
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('ClientMirakl — postMultipart', () => {
  it('manda un FormData senza forzare Content-Type, con la chiave nuda in Authorization', async () => {
    const chiamate: { url: string; init: RequestInit }[] = []
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string, init: RequestInit) => {
        chiamate.push({ url, init })
        return new Response(JSON.stringify({ id: 'msg-1' }), { status: 200 })
      }),
    )

    const client = new ClientMirakl(operatore, logger)
    const form = new FormData()
    form.append('message_input.body', 'ciao')
    form.append('files', new Blob([new Uint8Array([1, 2, 3])], { type: 'image/png' }), 'foto.png')

    const risposta = await client.postMultipart<{ id: string }>('/inbox/threads/T1/message', form)

    expect(risposta.id).toBe('msg-1')
    expect(chiamate).toHaveLength(1)
    const [{ url, init }] = chiamate
    expect(url).toBe('https://esempio.mirakl.net/api/inbox/threads/T1/message')
    expect(init.method).toBe('POST')
    expect(init.body).toBe(form)
    // Verificato: la chiave nuda, senza Bearer — coerente con get/post.
    const headers = init.headers as Record<string, string>
    expect(headers.Authorization).toBe('chiave-segreta')
    // Niente Content-Type impostato a mano: fetch calcola da solo il
    // boundary multipart. Impostarlo qui romperebbe la richiesta.
    expect(headers['Content-Type']).toBeUndefined()
  })

  it('passa shop_id come query param quando configurato — un account multi-shop scrive sullo shop giusto', async () => {
    // Trovato dopo il fix lato lettura (M11): solo la GET passava
    // shop_id, la POST no — un invio su un operatore multi-shop
    // continuava a fallire perché scriveva sempre sullo shop di
    // default, non su quello del thread.
    const chiamate: { url: string }[] = []
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        chiamate.push({ url })
        return new Response(JSON.stringify({ id: 'msg-1' }), { status: 200 })
      }),
    )

    const client = new ClientMirakl({ ...operatore, shop_id: '5079' }, logger)
    const form = new FormData()
    form.append('message_input.body', 'ciao')

    await client.postMultipart('/inbox/threads/T1/message', form, { shop_id: '5079' })

    expect(chiamate).toHaveLength(1)
    expect(chiamate[0]!.url).toBe(
      'https://esempio.mirakl.net/api/inbox/threads/T1/message?shop_id=5079',
    )
  })
})

describe('ClientMirakl — download (M13)', () => {
  it('passa shop_id come query param: su un account multi-shop il download parlava con lo shop sbagliato', async () => {
    // Terza volta per la stessa causa: M11 (lettura), M12 (scrittura) e
    // ora M13. Prova sui dati reali: lo stesso codice ha scaricato 112
    // allegati sull'operatore senza shop_id e zero su quello che ne ha uno.
    const chiamate: { url: string; init: RequestInit }[] = []
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string, init: RequestInit) => {
        chiamate.push({ url, init })
        return new Response(new Uint8Array([1, 2, 3]), {
          status: 200,
          headers: { 'content-type': 'image/jpeg' },
        })
      }),
    )

    const client = new ClientMirakl({ ...operatore, shop_id: '5079' }, logger)
    const esito = await client.download('/inbox/threads/ALL-1/download', {
      shop_id: client.shop_id ?? undefined,
    })

    expect(esito.mime).toBe('image/jpeg')
    expect(esito.contenuto).toEqual(Buffer.from([1, 2, 3]))
    expect(chiamate).toHaveLength(1)
    expect(chiamate[0]!.url).toBe(
      'https://esempio.mirakl.net/api/inbox/threads/ALL-1/download?shop_id=5079',
    )
  })

  it('non chiede application/json a un endpoint che risponde byte', async () => {
    const chiamate: { init: RequestInit }[] = []
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_url: string, init: RequestInit) => {
        chiamate.push({ init })
        return new Response(new Uint8Array([1]), { status: 200 })
      }),
    )

    const client = new ClientMirakl(operatore, logger)
    await client.download('/inbox/threads/ALL-1/download')

    const headers = chiamate[0]!.init.headers as Record<string, string>
    expect(headers.Accept).not.toBe('application/json')
    // La chiave resta quella giusta: l'header sovrascrivibile non la tocca.
    expect(headers.Authorization).toBe('chiave-segreta')
  })

  it('le richieste JSON continuano a chiedere application/json', async () => {
    const chiamate: { init: RequestInit }[] = []
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_url: string, init: RequestInit) => {
        chiamate.push({ init })
        return new Response(JSON.stringify({ data: [] }), { status: 200 })
      }),
    )

    const client = new ClientMirakl(operatore, logger)
    await client.get('/inbox/threads', {})

    const headers = chiamate[0]!.init.headers as Record<string, string>
    expect(headers.Accept).toBe('application/json')
  })
})
