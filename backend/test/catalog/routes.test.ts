import { generateKeyPairSync } from 'node:crypto'
import Fastify, { type FastifyInstance } from 'fastify'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { denyList } from '../../src/auth/deny-list.js'
import { signingKeyFromPem } from '../../src/auth/jwt.js'
import { dclClient, MAINNET_URL } from '../../src/catalog/dcl.js'
import { registerCatalogRoutes } from '../../src/catalog/routes.js'
import { CATALOG_DB, forgetCatalogDatabase } from '../../src/catalog/store.js'
import { redactionOptions } from '../../src/logging.js'
import { buildServer } from '../../src/server.js'
import { loadContract, operationsOf, validate } from '../support/contract.js'
import { fakeCouch } from '../support/couch.js'
import { AQARA_ROUTES, fakeDcl, type Recorded } from '../support/dcl.js'
import { accessTokenFor } from '../support/tokens.js'

const KEY = (() => {
  const { privateKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' })
  return signingKeyFromPem(
    'catalog',
    privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
  )
})()

const ADA = { sub: 'google|ada', email: 'ada@example.test' }
const GRACE = { sub: 'google|grace', email: 'grace@example.test' }

/** Reference vectors: see `decode.test.ts` for where they come from. */
const TEST_VENDOR_QR = 'MT:Y.K9042C00KA0648G00'
const AQARA_QR = 'MT:CUSJ0YJB00KA0648G00'
const AQARA_LONG = '749701123304447081941'
const AQARA_UNKNOWN_MODEL_QR = 'MT:0W-T3ELB00KA0648G00'
const SHORT_MANUAL = '34970112332'

const NOW = new Date('2026-10-05T16:20:00.000Z')

const operation = operationsOf(loadContract()).find(
  (candidate) => candidate.method === 'POST' && candidate.path === '/catalog/lookup',
)

let app: FastifyInstance | undefined

beforeEach(() => forgetCatalogDatabase())
afterEach(async () => {
  await app?.close()
  app = undefined
})

/**
 * The route on a bare Fastify, logging **everything** into `lines` through the service's own
 * redaction options — so the redaction assertion reads what this service would really write.
 */
function catalogApp(
  options: {
    routes?: Readonly<Record<string, Recorded | Error>>
    seed?: Record<string, Record<string, unknown>>
    max?: number
  } = {},
) {
  const lines: string[] = []
  const couch = fakeCouch(options.seed === undefined ? {} : { seed: options.seed })
  const dcl = fakeDcl(options.routes ?? AQARA_ROUTES)
  const deny = denyList(() => Math.floor(Date.now() / 1000))
  const instance = Fastify({
    logger: {
      ...redactionOptions(),
      level: 'trace',
      stream: { write: (line) => lines.push(line) },
    },
  })
  registerCatalogRoutes(instance, {
    couch: couch.couch,
    key: KEY,
    deny,
    dcl: dclClient(MAINNET_URL, dcl.fetch),
    limit: { max: options.max ?? 120, windowSeconds: 300 },
    clock: () => NOW,
  })
  app = instance
  return { app: instance, couch, dcl, lines, deny }
}

/** One lookup, signed in as `who` unless `who` is `null`. */
const lookup = (instance: FastifyInstance, payload: unknown, who: typeof ADA | null = ADA) =>
  instance.inject({
    method: 'POST',
    url: '/catalog/lookup',
    payload: payload as object,
    headers: {
      'content-type': 'application/json',
      ...(who === null ? {} : { authorization: `Bearer ${accessTokenFor(KEY, who)}` }),
    },
  })

/** The response checked against the contract for its status, media type included. */
function expectContract(response: Awaited<ReturnType<typeof lookup>>): void {
  const status = String(response.statusCode)
  expect(operation?.declared, `${status} is not declared`).toContain(status)
  expect(response.headers['content-type']).toMatch(
    new RegExp(`^${operation?.mediaTypes[status]?.replace('+', '\\+')}(;|$)`),
  )
  expect(validate(response.json(), operation?.responses[status])).toEqual([])
}

describe('POST /catalog/lookup: the error table', () => {
  it('answers 401 without a token', async () => {
    const { app, dcl } = catalogApp()
    const response = await lookup(app, { code: AQARA_QR }, null)
    expect(response.statusCode).toBe(401)
    expect(response.json()).toMatchObject({ title: 'Not signed in' })
    expect(dcl.requests).toEqual([])
    expectContract(response)
  })

  it('answers 401 to a signed-out token', async () => {
    const { app, deny } = catalogApp()
    const token = accessTokenFor(KEY, ADA)
    const jti = JSON.parse(Buffer.from(token.split('.')[1] ?? '', 'base64url').toString()).jti
    deny.deny(jti, Math.floor(Date.now() / 1000) + 3600)
    const response = await app.inject({
      method: 'POST',
      url: '/catalog/lookup',
      payload: { code: AQARA_QR },
      headers: { authorization: `Bearer ${token}` },
    })
    expect(response.statusCode).toBe(401)
    expect(response.json()).toMatchObject({ title: 'Not signed in' })
    expectContract(response)
  })

  it.each([
    ['no code', {}],
    ['a code that is not text', { code: 4447 }],
    ['text that is not a code', { code: 'hello' }],
    ['a lower-case prefix', { code: AQARA_QR.toLowerCase() }],
  ])('answers 400 for %s', async (_case, payload) => {
    const { app, dcl } = catalogApp()
    const response = await lookup(app, payload)
    expect(response.statusCode).toBe(400)
    expect(response.json()).toMatchObject({ title: 'Not a setup code' })
    expect(dcl.requests).toEqual([])
    expectContract(response)
  })

  it('answers 400 for a request with no body at all', async () => {
    const { app } = catalogApp()
    const response = await app.inject({
      method: 'POST',
      url: '/catalog/lookup',
      headers: { authorization: `Bearer ${accessTokenFor(KEY, ADA)}` },
    })
    expect(response.statusCode).toBe(400)
    expectContract(response)
  })

  it('answers 422 for the 11-digit manual code', async () => {
    const { app, dcl } = catalogApp()
    const response = await lookup(app, { code: SHORT_MANUAL })
    expect(response.statusCode).toBe(422)
    expect(response.json()).toMatchObject({ title: 'No vendor or product id in this code' })
    expect(dcl.requests).toEqual([])
    expectContract(response)
  })

  it('answers 429 with retry-after past the limit, counted per subject', async () => {
    const { app } = catalogApp({ max: 2 })
    await lookup(app, { code: TEST_VENDOR_QR })
    await lookup(app, { code: TEST_VENDOR_QR })
    const refused = await lookup(app, { code: TEST_VENDOR_QR })

    expect(refused.statusCode).toBe(429)
    expect(Number(refused.headers['retry-after'])).toBeGreaterThanOrEqual(1)
    expectContract(refused)
    // Somebody else's budget is their own.
    expect((await lookup(app, { code: TEST_VENDOR_QR }, GRACE)).statusCode).toBe(200)
  })

  it('does not let unauthenticated requests spend a signed-in budget', async () => {
    const { app } = catalogApp({ max: 1 })
    for (const _ of [1, 2, 3]) await lookup(app, { code: TEST_VENDOR_QR }, null)
    expect((await lookup(app, { code: TEST_VENDOR_QR })).statusCode).toBe(200)
  })

  it('answers 503 when the DCL is down and nothing is cached', async () => {
    const { app } = catalogApp({
      routes: { '/vendorinfo/vendors/4447': new TypeError('fetch failed') },
    })
    const response = await lookup(app, { code: AQARA_QR })
    expect(response.statusCode).toBe(503)
    expect(response.json()).toMatchObject({ title: 'Catalogue unavailable' })
    expectContract(response)
  })
})

describe('POST /catalog/lookup: answers', () => {
  it('answers the Aqara sensor from the DCL, and the manual code the same', async () => {
    const { app } = catalogApp()
    const response = await lookup(app, { code: AQARA_QR })

    expect(response.statusCode).toBe(200)
    expect(response.headers['cache-control']).toBe('private, no-store')
    expect(response.json()).toMatchObject({
      vendorId: 4447,
      productId: 8194,
      source: 'dcl',
      vendor: { name: 'Aqara', preferredName: null },
      product: { name: 'Aqara Door and Window Sensor P2', partNumber: 'AS056', supportUrl: null },
      fetchedAt: NOW.toISOString(),
      stale: false,
    })
    expectContract(response)
    expect((await lookup(app, { code: ` ${AQARA_LONG} ` })).json()).toMatchObject({
      source: 'dcl',
    })
  })

  it('answers 200 missing, with the vendor, for a model the DCL does not have', async () => {
    const { app } = catalogApp()
    const response = await lookup(app, { code: AQARA_UNKNOWN_MODEL_QR })
    expect(response.statusCode).toBe(200)
    expect(response.json()).toMatchObject({
      productId: 9999,
      source: 'missing',
      vendor: { name: 'Aqara' },
      product: null,
    })
    expectContract(response)
  })

  it('answers a test vendor locally, touching neither CouchDB nor the DCL', async () => {
    const { app, couch, dcl } = catalogApp()
    const response = await lookup(app, { code: TEST_VENDOR_QR })

    expect(response.json()).toMatchObject({
      vendorId: 0xfff1,
      source: 'test-vendor',
      vendor: { name: 'Test vendor' },
      product: null,
    })
    expect(dcl.requests).toEqual([])
    expect(couch.calls).toEqual([])
    expectContract(response)
  })

  it('answers a cache hit without calling the DCL', async () => {
    const { app, dcl } = catalogApp()
    await lookup(app, { code: AQARA_QR })
    const before = dcl.requests.length
    const again = await lookup(app, { code: AQARA_QR })

    expect(again.json()).toMatchObject({ source: 'dcl', stale: false })
    expect(dcl.requests.length).toBe(before)
  })

  it('serves a stale entry when the DCL fails', async () => {
    const old = '2026-01-01T00:00:00.000Z'
    const { app } = catalogApp({
      routes: {
        '/vendorinfo/vendors/4447': new TypeError('fetch failed'),
        '/model/models/4447/8194': new TypeError('fetch failed'),
      },
      seed: {
        [`${CATALOG_DB}/vendor:4447`]: {
          _id: 'vendor:4447',
          _rev: '1-a',
          type: 'vendor',
          vid: 4447,
          status: 'found',
          fetchedAt: old,
          network: 'mainnet',
          dcl: { vendorID: 4447, vendorName: 'Aqara' },
        },
        [`${CATALOG_DB}/model:4447:8194`]: {
          _id: 'model:4447:8194',
          _rev: '1-a',
          type: 'model',
          vid: 4447,
          pid: 8194,
          status: 'found',
          fetchedAt: old,
          network: 'mainnet',
          dcl: { vid: 4447, pid: 8194, productName: 'Aqara Door and Window Sensor P2' },
        },
      },
    })
    const response = await lookup(app, { code: AQARA_QR })

    expect(response.statusCode).toBe(200)
    expect(response.json()).toMatchObject({ source: 'dcl', stale: true, fetchedAt: old })
    expectContract(response)
  })
})

describe('POST /catalog/lookup: the code never reaches a log or a response', () => {
  it('logs no MT: and no manual-code digits, on any path', async () => {
    const { app, lines } = catalogApp({
      routes: { '/vendorinfo/vendors/4447': new TypeError('fetch failed') },
    })
    const responses = [
      await lookup(app, { code: AQARA_QR }), // 503, with a warning logged
      await lookup(app, { code: AQARA_LONG }), // 503 again
      await lookup(app, { code: `${AQARA_QR}$` }), // 400
      await lookup(app, { code: SHORT_MANUAL }), // 422
      await lookup(app, { code: TEST_VENDOR_QR }), // 200
      // Not JSON at all: Fastify's own parser refuses it.
      await app.inject({
        method: 'POST',
        url: '/catalog/lookup',
        payload: AQARA_QR,
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${accessTokenFor(KEY, ADA)}`,
        },
      }),
    ]
    const log = lines.join('\n')

    // The positive control: logging was on and the warning path ran, so silence means redaction
    // rather than a logger that was never called.
    expect(log).toContain('DCL unavailable')
    expect(log).not.toContain('MT:')
    expect(log).not.toContain(AQARA_LONG)
    expect(log).not.toContain(SHORT_MANUAL)
    for (const response of responses) {
      expect(response.body).not.toContain('MT:')
      expect(response.body).not.toContain(AQARA_LONG)
      expect(response.body).not.toContain(SHORT_MANUAL)
    }
  })
})

describe('buildServer wiring', () => {
  it('registers the route only when catalogue dependencies are given', () => {
    const without = buildServer({ logger: false })
    expect(without.registeredRoutes().map((route) => route.url)).not.toContain('/catalog/lookup')
    void without.close()
  })

  it('takes the limit from the security options', async () => {
    const couch = fakeCouch()
    const server = buildServer({
      logger: false,
      security: {
        limits: {
          auth: { max: 20, windowSeconds: 300 },
          token: { max: 60, windowSeconds: 300 },
          catalog: { max: 1, windowSeconds: 300 },
        },
      },
      catalog: { couch: couch.couch, key: KEY, dcl: dclClient(MAINNET_URL, fakeDcl().fetch) },
    })
    app = server
    expect((await lookup(server, { code: TEST_VENDOR_QR })).statusCode).toBe(200)
    expect((await lookup(server, { code: TEST_VENDOR_QR })).statusCode).toBe(429)
  })
})
