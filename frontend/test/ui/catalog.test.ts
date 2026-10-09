import { afterEach, describe, expect, it, vi } from 'vitest'
import { type CatalogLookup, decodePayload, encodePayload } from '../../src/domain/index.js'
import {
  answeringTestVendors,
  type CatalogApi,
  catalogApi,
  DEFAULT_RETRY_AFTER_SECONDS,
  isCatalogLookup,
  retryAfterSeconds,
} from '../../src/ui/catalog.js'
import { AQARA_LOOKUP } from './support/catalog.js'

const CODE = 'MT:Y.K9042C00KA0648G00'

const ANSWER: CatalogLookup = {
  vendorId: 0xfff1,
  productId: 0x8000,
  source: 'test-vendor',
  vendor: { name: 'Test vendor', preferredName: null, legalName: null, landingPageUrl: null },
  product: null,
  fetchedAt: '2026-10-05T16:20:00.000Z',
  stale: false,
}

/** A `fetch` that answers once with the given response and records what it was asked. */
function answering(response: Response | Error) {
  const calls: Array<{ url: string; init: RequestInit | undefined }> = []
  const fetchImpl = (async (url: string, init?: RequestInit) => {
    calls.push({ url, init })
    if (response instanceof Error) throw response
    return response
  }) as unknown as typeof fetch
  return { calls, fetchImpl }
}

const json = (status: number, body: unknown, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  })

afterEach(() => {
  vi.restoreAllMocks()
})

describe('catalogApi', () => {
  it('posts the code in the body, with the bearer token, never in the URL', async () => {
    const { calls, fetchImpl } = answering(json(200, ANSWER))
    await catalogApi('/api/', () => 'tok', fetchImpl).lookup(CODE)

    expect(calls[0]?.url).toBe('/api/catalog/lookup')
    expect(calls[0]?.url).not.toContain('MT:')
    expect(calls[0]?.init?.method).toBe('POST')
    expect(JSON.parse(String(calls[0]?.init?.body))).toEqual({ code: CODE })
    const headers = calls[0]?.init?.headers as Record<string, string>
    expect(headers.authorization).toBe('Bearer tok')
  })

  it('reports a found answer', async () => {
    const { fetchImpl } = answering(json(200, ANSWER))
    expect(await catalogApi('/api', () => 'tok', fetchImpl).lookup(CODE)).toEqual({
      kind: 'found',
      lookup: ANSWER,
    })
  })

  it('answers signed-out without a request when no token is held', async () => {
    const { calls, fetchImpl } = answering(json(200, ANSWER))
    expect(await catalogApi('/api', () => undefined, fetchImpl).lookup(CODE)).toEqual({
      kind: 'signed-out',
    })
    expect(calls).toHaveLength(0)
  })

  it.each([
    [401, { kind: 'signed-out' }],
    [400, { kind: 'unusable' }],
    [422, { kind: 'unusable' }],
    [403, { kind: 'unavailable' }],
    [500, { kind: 'unavailable' }],
    [503, { kind: 'unavailable' }],
  ])('maps %i to %o', async (status, outcome) => {
    const { fetchImpl } = answering(json(status, { title: 'x' }))
    expect(await catalogApi('/api', () => 'tok', fetchImpl).lookup(CODE)).toEqual(outcome)
  })

  it('reports rate limiting with the server’s retry-after', async () => {
    const { fetchImpl } = answering(json(429, {}, { 'retry-after': '17' }))
    expect(await catalogApi('/api', () => 'tok', fetchImpl).lookup(CODE)).toEqual({
      kind: 'rate-limited',
      retryAfterSeconds: 17,
    })
  })

  it('reports a network failure or an abort as unavailable, and never throws', async () => {
    const { fetchImpl } = answering(new TypeError('Failed to fetch'))
    expect(await catalogApi('/api', () => 'tok', fetchImpl).lookup(CODE)).toEqual({
      kind: 'unavailable',
    })
    const aborted = answering(new DOMException('aborted', 'AbortError'))
    expect(await catalogApi('/api', () => 'tok', aborted.fetchImpl).lookup(CODE)).toEqual({
      kind: 'unavailable',
    })
  })

  it('passes the abort signal to fetch', async () => {
    const { calls, fetchImpl } = answering(json(200, ANSWER))
    const controller = new AbortController()
    await catalogApi('/api', () => 'tok', fetchImpl).lookup(CODE, controller.signal)
    expect(calls[0]?.init?.signal).toBe(controller.signal)
  })

  it('treats a 200 that is not a catalogue answer as unavailable', async () => {
    for (const body of [{}, { ...ANSWER, source: 'guess' }, 'nope']) {
      const { fetchImpl } = answering(json(200, body))
      expect(await catalogApi('/api', () => 'tok', fetchImpl).lookup(CODE)).toEqual({
        kind: 'unavailable',
      })
    }
    const garbled = answering(new Response('<html>', { status: 200 }))
    expect(await catalogApi('/api', () => 'tok', garbled.fetchImpl).lookup(CODE)).toEqual({
      kind: 'unavailable',
    })
  })

  it('never writes the code to the console', async () => {
    const spies = (['log', 'info', 'warn', 'error', 'debug'] as const).map((name) =>
      vi.spyOn(console, name).mockImplementation(() => {}),
    )
    for (const response of [new TypeError('x'), json(500, {}), json(200, {})]) {
      await catalogApi('/api', () => 'tok', answering(response).fetchImpl).lookup(CODE)
    }
    for (const spy of spies) expect(spy).not.toHaveBeenCalled()
  })
})

describe('retryAfterSeconds', () => {
  it.each([
    ['17', 17],
    ['0.2', 1],
    ['99999', 3600],
    ['0', DEFAULT_RETRY_AFTER_SECONDS],
    ['Wed, 21 Oct 2026 07:28:00 GMT', DEFAULT_RETRY_AFTER_SECONDS],
    [null, DEFAULT_RETRY_AFTER_SECONDS],
  ])('%s → %i', (header, seconds) => {
    expect(retryAfterSeconds(header)).toBe(seconds)
  })
})

describe('isCatalogLookup', () => {
  it('accepts a found answer with a vendor and a product', () => {
    expect(
      isCatalogLookup({
        ...ANSWER,
        source: 'dcl',
        product: {
          name: 'P2',
          label: null,
          partNumber: 'AS056',
          deviceTypeId: 21,
          productUrl: null,
          supportUrl: null,
          userManualUrl: null,
          commissioningCustomFlow: 0,
          commissioningCustomFlowUrl: null,
          commissioningInstructions: null,
          factoryResetInstructions: null,
        },
      }),
    ).toBe(true)
  })

  it('accepts a missing answer with a null vendor and a null product', () => {
    expect(isCatalogLookup({ ...ANSWER, source: 'missing', vendor: null, product: null })).toBe(
      true,
    )
  })

  it.each(['vendorId', 'productId', 'source', 'vendor', 'product', 'fetchedAt', 'stale'])(
    'refuses an answer without %s',
    (key) => {
      const { [key as keyof CatalogLookup]: _omitted, ...rest } = ANSWER
      expect(isCatalogLookup(rest)).toBe(false)
    },
  )

  it.each([
    ['vendorId', { vendorId: 4447.5 }],
    ['productId', { productId: 1.25 }],
  ])('refuses a non-integer %s', (_name, patch) => {
    expect(isCatalogLookup({ ...ANSWER, ...patch })).toBe(false)
  })

  it('refuses a product whose deviceTypeId or commissioningCustomFlow is not an integer', () => {
    const product = { ...AQARA_LOOKUP.product, deviceTypeId: 21 }
    expect(isCatalogLookup({ ...AQARA_LOOKUP, product })).toBe(true)
    expect(isCatalogLookup({ ...AQARA_LOOKUP, product: { ...product, deviceTypeId: 21.5 } })).toBe(
      false,
    )
    expect(
      isCatalogLookup({ ...AQARA_LOOKUP, product: { ...product, commissioningCustomFlow: 0.5 } }),
    ).toBe(false)
  })

  it('refuses a product whose fields have the wrong types', () => {
    expect(isCatalogLookup({ ...ANSWER, product: { name: 7 } })).toBe(false)
    expect(isCatalogLookup({ ...ANSWER, vendor: { name: 'x', preferredName: 3 } })).toBe(false)
  })
})

/** #238: test-vendor codes are answered here and never reach the API. */
describe('answeringTestVendors', () => {
  const NOW = new Date('2026-10-09T08:00:00.000Z')

  /** An inner API that records what it was asked and answers `unavailable`. */
  function recording() {
    const asked: string[] = []
    const api: CatalogApi = {
      async lookup(code) {
        asked.push(code)
        return { kind: 'unavailable' }
      },
    }
    return { asked, api }
  }

  it('answers a test-vendor code without asking the API', async () => {
    const { asked, api } = recording()
    const outcome = await answeringTestVendors(api, () => NOW).lookup(CODE)

    expect(outcome).toEqual({
      kind: 'found',
      lookup: { ...ANSWER, fetchedAt: NOW.toISOString() },
    })
    expect(asked).toHaveLength(0)
  })

  it('passes every other code, and the signal, through unchanged', async () => {
    const real = encodePayload({ ...decodePayload(CODE), vendorId: 0x1234 })
    const signals: Array<AbortSignal | undefined> = []
    const inner: CatalogApi = {
      async lookup(_code, signal) {
        signals.push(signal)
        return { kind: 'rate-limited', retryAfterSeconds: 5 }
      },
    }
    const controller = new AbortController()

    expect(await answeringTestVendors(inner, () => NOW).lookup(real, controller.signal)).toEqual({
      kind: 'rate-limited',
      retryAfterSeconds: 5,
    })
    expect(signals).toEqual([controller.signal])

    const { asked, api } = recording()
    await answeringTestVendors(api, () => NOW).lookup('not a code')
    expect(asked).toEqual(['not a code'])
  })
})
