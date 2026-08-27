import { generateKeyPairSync } from 'node:crypto'
import { afterEach, describe, expect, it } from 'vitest'
import { type Environment, serverOptions } from '../src/composition.js'
import { buildServer, type Server } from '../src/server.js'

const PEM = generateKeyPairSync('ec', {
  namedCurve: 'prime256v1',
  privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  publicKeyEncoding: { type: 'spki', format: 'pem' },
}).privateKey as unknown as string

/** Everything a deployment needs for the project routes. */
const COMPLETE: Environment = {
  COUCHDB_URL: 'http://couch.test:5984',
  COUCHDB_ADMIN_USER: 'admin',
  COUCHDB_ADMIN_PASSWORD: 'secret',
  JWT_PRIVATE_KEY: PEM,
  JWT_KEY_ID: 'ec-2026-08',
  APP_ORIGIN: 'https://matter.example',
}

let app: Server | undefined

afterEach(async () => {
  await app?.close()
  app = undefined
})

/** Which routes a server built from this environment ends up with. */
function routesFor(env: Environment): string[] {
  app = buildServer({ logger: false, ...serverOptions(env) })
  return app.registeredRoutes().map((route) => `${route.method} ${route.url}`)
}

describe('a fully configured deployment', () => {
  it('serves the project routes', () => {
    expect(routesFor(COMPLETE)).toEqual(expect.arrayContaining(['POST /projects', 'GET /projects']))
  })

  it("allows the application's own origin", () => {
    expect(serverOptions(COMPLETE).security?.origins).toEqual(['https://matter.example'])
  })
})

describe('a deployment that is part-way through being set up', () => {
  it('serves no project routes without CouchDB', () => {
    // **Absent means absent.** The alternative is registering routes that answer with a
    // misconfiguration error at the moment somebody presses the button — which reads as a
    // broken application rather than as an incomplete deployment.
    const { COUCHDB_URL: _url, ...withoutCouch } = COMPLETE

    expect(routesFor(withoutCouch)).not.toContain('POST /projects')
  })

  it('serves no project routes without a signing key', () => {
    // CouchDB can create the database; without the key there is no way to know who is asking.
    // Half of what is needed is not most of the way there.
    const { JWT_PRIVATE_KEY: _pem, ...withoutKey } = COMPLETE

    expect(routesFor(withoutKey)).not.toContain('POST /projects')
  })

  it('serves no project routes when the key has no id', () => {
    // The `kid` names the key in the token header and in CouchDB's `[jwt_keys]`. A key with no
    // name mints tokens CouchDB cannot match to anything.
    const { JWT_KEY_ID: _kid, ...withoutKid } = COMPLETE

    expect(routesFor(withoutKid)).not.toContain('POST /projects')
  })

  it('still answers its health check', () => {
    // Liveness does not depend on configuration. A deployment being brought up should look
    // alive, because it is.
    expect(routesFor({})).toContain('GET /healthz')
  })

  it('treats an empty variable as unset rather than as a value', () => {
    expect(routesFor({ ...COMPLETE, COUCHDB_URL: '' })).not.toContain('POST /projects')
  })
})

describe('a deployment that is configured wrongly', () => {
  it('refuses to start on an unusable origin', () => {
    // At startup, once. The failure it prevents — the real application quietly refused — looks
    // exactly like a browser problem and happens only in production.
    expect(() =>
      buildServer({
        logger: false,
        ...serverOptions({ ...COMPLETE, APP_ORIGIN: 'matter.example' }),
      }),
    ).toThrow(/origin/i)
  })

  it('refuses a signing key that is not an EC key', () => {
    // ES256 is what CouchDB is configured to validate. An RSA key here mints tokens every
    // request would then be refused for, which presents as "sign-in works, nothing else does".
    const rsa = generateKeyPairSync('rsa', {
      modulusLength: 2048,
      privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
      publicKeyEncoding: { type: 'spki', format: 'pem' },
    }).privateKey as unknown as string

    expect(() => serverOptions({ ...COMPLETE, JWT_PRIVATE_KEY: rsa })).toThrow(/EC key/i)
  })
})
