import { generateKeyPairSync } from 'node:crypto'
import { afterEach, describe, expect, it } from 'vitest'
import { type Environment, serverOptions } from '../src/composition.js'
import { buildServer, type Server } from '../src/server.js'

const PEM = generateKeyPairSync('ec', {
  namedCurve: 'prime256v1',
  privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  publicKeyEncoding: { type: 'spki', format: 'pem' },
}).privateKey as unknown as string

/** A *second* key, because sessions must not be signed with the one CouchDB validates. */
const SESSION_PEM = generateKeyPairSync('ec', {
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
  JWT_SESSION_PRIVATE_KEY: SESSION_PEM,
  JWT_KEY_ID: 'ec-2026-08',
  APP_ORIGIN: 'https://matter.example',
  GOOGLE_CLIENT_ID: '1234.apps.googleusercontent.com',
  GOOGLE_CLIENT_SECRET: 'GOCSPX-secret',
  GOOGLE_REDIRECT_URI: 'https://api.matter.example/auth/google/callback',
}

/** The operations sign-in adds, straight from `auth/routes.ts`. */
const SIGN_IN_ROUTES = [
  'GET /auth/google',
  'GET /auth/google/callback',
  'POST /auth/signout',
  'POST /auth/token',
]

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

  it('serves the sign-in routes', () => {
    // The gap this test was written for: every variable below was documented, passed through
    // `compose.prod.yml`, and read by nothing. A deployment with a Google client configured
    // answered `GET /auth/google` with 404 — which reads as a broken application, not as an
    // incomplete deployment, and is exactly what `serverOptions` exists to prevent.
    expect(routesFor(COMPLETE)).toEqual(expect.arrayContaining(SIGN_IN_ROUTES))
  })

  it('serves the profile routes', () => {
    // Sign-in writes a `_users` document through the same store `GET /profile` reads. Wiring
    // one without the other gives a user who can sign in and then cannot be shown their name.
    expect(routesFor(COMPLETE)).toEqual(expect.arrayContaining(['GET /profile', 'PUT /profile']))
  })

  it('sends the browser back to the application, not to the API', () => {
    // `appOrigin` is where the callback redirects to when sign-in succeeds. Defaulting it to
    // the API's own host would land the user on a JSON endpoint holding a session cookie.
    expect(serverOptions(COMPLETE).auth?.appOrigin).toBe('https://matter.example')
  })

  it('trims a trailing slash from the application origin', () => {
    // The callback redirects to `${appOrigin}/`. A deployment that wrote the origin with its
    // own slash would send every successful sign-in to `https://matter.example//`, which the
    // application does not serve — a sign-in that works and then lands on a 404.
    const withSlash = { ...COMPLETE, APP_ORIGIN: 'https://matter.example/' }

    expect(serverOptions(withSlash).auth?.appOrigin).toBe('https://matter.example')
  })

  it('asks Google for nothing beyond identity', () => {
    // Any fourth scope makes this project subject to Google's verification review. That is a
    // consequence of a one-line edit in `google.ts`, so it is asserted where it is observable.
    expect(serverOptions(COMPLETE).auth?.provider.scopes).toEqual(['openid', 'email', 'profile'])
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

  it('serves no sign-in routes without a Google client', () => {
    const { GOOGLE_CLIENT_ID: _id, ...withoutClient } = COMPLETE

    expect(routesFor(withoutClient)).not.toContain('GET /auth/google')
  })

  it('serves no sign-in routes without the client secret', () => {
    // The code exchange is server-to-server and carries the secret. Without it every sign-in
    // reaches Google, returns, and fails at the exchange — after the user has consented.
    const { GOOGLE_CLIENT_SECRET: _secret, ...withoutSecret } = COMPLETE

    expect(routesFor(withoutSecret)).not.toContain('GET /auth/google')
  })

  it('serves no sign-in routes without a redirect URI', () => {
    // Google matches it byte-for-byte against what is registered. There is no value this
    // service could invent that would be right, so absent means absent here too.
    const { GOOGLE_REDIRECT_URI: _uri, ...withoutRedirect } = COMPLETE

    expect(routesFor(withoutRedirect)).not.toContain('GET /auth/google')
  })

  it('serves no sign-in routes without a session key', () => {
    // **No fallback to JWT_PRIVATE_KEY.** That key is installed in CouchDB's `[jwt_keys]`, so
    // signing sessions with it would make a thirty-day session cookie a thirty-day database
    // credential — the exact thing the second key exists to remove. A deployment that forgot
    // should serve no sign-in rather than quietly reinstate it.
    const { JWT_SESSION_PRIVATE_KEY: _session, ...withoutSession } = COMPLETE

    expect(routesFor(withoutSession)).not.toContain('GET /auth/google')
  })

  it('serves no profile routes without a session key', () => {
    // The profile authenticates by the session cookie, so without a key to verify one it is a
    // route that can never admit anybody.
    const { JWT_SESSION_PRIVATE_KEY: _session, ...withoutSession } = COMPLETE

    expect(routesFor(withoutSession)).not.toContain('GET /profile')
  })

  it('signs sessions with a different key from the one CouchDB is given', () => {
    // The property itself, asserted where it is decided. Two keys that happened to be equal
    // would satisfy every other test in this file.
    const options = serverOptions(COMPLETE)

    expect(options.auth?.sessionKey.kid).not.toBe(options.auth?.key.kid)
    expect(options.auth?.sessionKey.publicKey.export({ type: 'spki', format: 'pem' })).not.toEqual(
      options.auth?.key.publicKey.export({ type: 'spki', format: 'pem' }),
    )
  })

  it('serves no sign-in routes without somewhere to send the user back to', () => {
    const { APP_ORIGIN: _origin, ...withoutOrigin } = COMPLETE

    expect(routesFor(withoutOrigin)).not.toContain('GET /auth/google')
  })

  it('treats an empty Google client id as unset rather than as a value', () => {
    // A deployment tool rendering `GOOGLE_CLIENT_ID=` for a secret it was never given has not
    // configured sign-in. Building a provider from it would reach Google and be refused for a
    // client id of `""` — an error about Google, for a mistake made here.
    expect(routesFor({ ...COMPLETE, GOOGLE_CLIENT_ID: '' })).not.toContain('GET /auth/google')
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
