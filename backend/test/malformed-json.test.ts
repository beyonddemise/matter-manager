import { generateKeyPairSync } from 'node:crypto'
import { afterEach, describe, expect, it } from 'vitest'
import { signingKeyFromPem } from '../src/auth/jwt.js'
import { refreshStore } from '../src/auth/refresh-store.js'
import { dclClient, MAINNET_URL } from '../src/catalog/dcl.js'
import { forgetCatalogDatabase } from '../src/catalog/store.js'
import { PROBLEM_JSON } from '../src/problem.js'
import { buildServer, type Server } from '../src/server.js'
import { recordEnsurer } from '../src/users/ensure.js'
import { userRecords } from '../src/users/records.js'
import { loadContract, operationsOf, validate } from './support/contract.js'
import { fakeCouch } from './support/couch.js'
import { fakeDcl } from './support/dcl.js'
import { accessTokenFor } from './support/tokens.js'

const KEY = (() => {
  const { privateKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' })
  return signingKeyFromPem(
    'malformed',
    privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
  )
})()

const ADA = { sub: 'google|ada', email: 'ada@example.test' }

/**
 * A body that is a setup code with its closing brace missing.
 *
 * The worst case for this refusal: the one route that receives a code, sent by a client that
 * got the JSON wrong. Neither the response nor the log may carry any of it.
 */
const CODE = 'MT:Y.K9042C00KA0648G00'
const BROKEN = `{"code":"${CODE}"`

const contract = operationsOf(loadContract())

let app: Server | undefined

afterEach(async () => {
  await app?.close()
  app = undefined
  forgetCatalogDatabase()
})

/** The whole service, with the catalogue and the projects, logging into `lines`. */
function service() {
  const lines: string[] = []
  const couch = fakeCouch()
  const records = userRecords(couch.couch)
  app = buildServer({
    logStream: { write: (line) => lines.push(line) },
    catalog: { couch: couch.couch, key: KEY, dcl: dclClient(MAINNET_URL, fakeDcl().fetch) },
    projects: {
      couch: couch.couch,
      key: KEY,
      records,
      ensureRecord: recordEnsurer(
        records,
        refreshStore(records, () => Math.floor(Date.now() / 1000)),
      ),
    },
  })
  return { app, lines }
}

/** One request with `payload` as its literal body, signed in as Ada. */
const post = (server: Server, url: string, payload: string, contentType = 'application/json') =>
  server.inject({
    method: 'POST',
    url,
    payload,
    headers: {
      'content-type': contentType,
      authorization: `Bearer ${accessTokenFor(KEY, ADA)}`,
    },
  })

describe('a JSON body that does not parse', () => {
  it.each([
    ['/catalog/lookup', BROKEN],
    ['/projects', `{"name":"${CODE}"`],
  ])('answers %s with a problem+json 400 the contract declares', async (url, payload) => {
    const { app } = service()
    const response = await post(app, url, payload)

    expect(response.statusCode).toBe(400)
    expect(response.headers['content-type']).toMatch(/^application\/problem\+json(;|$)/)
    expect(response.json()).toEqual({ title: 'Malformed JSON', status: 400 })

    const operation = contract.find((each) => each.method === 'POST' && each.path === url)
    expect(operation?.declared).toContain('400')
    expect(operation?.mediaTypes['400']).toBe(PROBLEM_JSON)
    expect(validate(response.json(), operation?.responses['400'])).toEqual([])
  })

  it('echoes neither the input nor the parser message', async () => {
    const { app } = service()
    const response = await post(app, '/catalog/lookup', BROKEN)

    expect(response.body).not.toContain(CODE)
    expect(response.body).not.toContain('MT:')
    // Fastify's own message. Fixed text today, but a parser's message is where input would
    // appear first — V8's `JSON.parse` quotes the text it choked on.
    expect(response.body).not.toMatch(/valid JSON|Unexpected|token/i)
  })

  it('writes nothing of the input to the log', async () => {
    const { app, lines } = service()
    await post(app, '/catalog/lookup', BROKEN)

    expect(lines.length).toBeGreaterThan(0)
    expect(lines.join('\n')).not.toContain(CODE)
    expect(lines.join('\n')).not.toContain('MT:')
  })
})

describe('an empty JSON body', () => {
  it('answers /catalog/lookup with the same problem+json 400', async () => {
    // The contract declares problem+json for a 400 on every JSON operation; an empty body is
    // the other way Fastify's parser refuses one before any handler runs.
    const { app, lines } = service()
    const response = await post(app, '/catalog/lookup', '')

    expect(response.statusCode).toBe(400)
    expect(response.headers['content-type']).toMatch(/^application\/problem\+json(;|$)/)
    expect(response.json()).toEqual({ title: 'Malformed JSON', status: 400 })
    expect(response.body).not.toMatch(/empty|content-type/i)
    expect(lines.join('\n')).not.toMatch(/Body cannot be empty/)
  })
})

describe('every other error', () => {
  it('keeps the answer it had: an unsupported media type is still Fastify’s 415', async () => {
    const { app } = service()
    const response = await post(app, '/catalog/lookup', 'code', 'text/csv')

    expect(response.statusCode).toBe(415)
    expect(response.headers['content-type']).toMatch(/^application\/json/)
    expect(response.json()).toMatchObject({ code: 'FST_ERR_CTP_INVALID_MEDIA_TYPE' })
  })
})
