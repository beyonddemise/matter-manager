import { afterEach, describe, expect, it } from 'vitest'
import { buildServer, type Server } from '../../src/server.js'

let app: Server | undefined

afterEach(async () => {
  await app?.close()
  app = undefined
})

/** A server with a known allowlist and a small limit, so a test can reach it. */
function server(overrides: Parameters<typeof buildServer>[0] = {}): Server {
  app = buildServer({
    logger: false,
    security: {
      origins: ['https://matter.example'],
      // Deliberately different, so that a single shared limiter would be visible rather than
      // merely present: the two endpoints are used at completely different rates.
      limits: { auth: { max: 3, windowSeconds: 60 }, token: { max: 6, windowSeconds: 60 } },
    },
    ...overrides,
  })
  return app
}

describe('the headers on an ordinary response', () => {
  it('are there', async () => {
    const response = await server().inject({ method: 'GET', url: '/healthz' })

    expect(response.headers['x-content-type-options']).toBe('nosniff')
    expect(response.headers['referrer-policy']).toBe('no-referrer')
  })

  it('include a default of not caching', async () => {
    const response = await server().inject({ method: 'GET', url: '/healthz' })

    expect(response.headers['cache-control']).toBe('no-store')
  })

  it('do not overwrite what a route decided for itself', async () => {
    // Which is a consequence of *where* they are applied, not of a guard: `onRequest` runs
    // before every handler, so a route that has something cacheable to say simply says it
    // later. Applying the same headers in `onSend` would quietly undo every such route.
    const built = server()
    built.get('/cacheable', async (_request, reply) => {
      reply.header('cache-control', 'public, max-age=60')
      return { ok: true }
    })

    const response = await built.inject({ method: 'GET', url: '/cacheable' })

    expect(response.headers['cache-control']).toBe('public, max-age=60')
  })

  it('are on error responses too', async () => {
    // The responses most likely to be read by something that should not have them.
    const response = await server().inject({ method: 'GET', url: '/nothing-here' })

    expect(response.statusCode).toBe(404)
    expect(response.headers['x-content-type-options']).toBe('nosniff')
  })
})

describe('a preflight', () => {
  it('is answered without reaching a route', async () => {
    const response = await server().inject({
      method: 'OPTIONS',
      url: '/profile',
      headers: {
        origin: 'https://matter.example',
        'access-control-request-method': 'PUT',
      },
    })

    expect(response.statusCode).toBe(204)
    expect(response.headers['access-control-allow-methods']).toContain('PUT')
  })

  it('is answered for a path that has no route at all', async () => {
    // Which is the point of handling it in a hook. `/profile` exists only when the profile
    // store is configured, and a preflight that 404s tells a browser the request is forbidden
    // rather than that the endpoint is not deployed.
    const response = await server().inject({
      method: 'OPTIONS',
      url: '/profile',
      headers: {
        origin: 'https://matter.example',
        'access-control-request-method': 'PUT',
      },
    })

    expect(response.statusCode).toBe(204)
  })

  it('registers no route, so the contract-drift check still sees only real operations', async () => {
    // An `OPTIONS *` route would appear in `registeredRoutes()` as an operation the contract
    // does not declare — and the drift check would then be reporting on Fastify's plumbing.
    const built = server()

    expect(built.registeredRoutes().map((route) => route.method)).not.toContain('OPTIONS')
  })

  it('tells an origin that is not on the list nothing', async () => {
    const response = await server().inject({
      method: 'OPTIONS',
      url: '/profile',
      headers: { origin: 'https://evil.example', 'access-control-request-method': 'PUT' },
    })

    expect(response.headers['access-control-allow-origin']).toBeUndefined()
  })

  it('varies by origin even then', async () => {
    const response = await server().inject({
      method: 'OPTIONS',
      url: '/profile',
      headers: { origin: 'https://evil.example', 'access-control-request-method': 'PUT' },
    })

    expect(response.headers.vary).toContain('Origin')
  })
})

describe('cross-origin headers on a real response', () => {
  it('permit the configured origin', async () => {
    const response = await server().inject({
      method: 'GET',
      url: '/healthz',
      headers: { origin: 'https://matter.example' },
    })

    expect(response.headers['access-control-allow-origin']).toBe('https://matter.example')
  })

  it('permit nobody when no origin is configured', async () => {
    // The default has to be closed. A deployment that forgot to set `APP_ORIGIN` should refuse
    // the application, not admit the internet.
    const built = buildServer({ logger: false })
    app = built
    const response = await built.inject({
      method: 'GET',
      url: '/healthz',
      headers: { origin: 'https://matter.example' },
    })

    expect(response.headers['access-control-allow-origin']).toBeUndefined()
  })
})

describe('a misconfigured allowlist', () => {
  it('stops the service from starting', async () => {
    // Rather than being dropped quietly. The alternative failure is the real application being
    // refused — in production, looking exactly like a browser problem — and startup is the only
    // moment anybody is in a position to notice.
    expect(() =>
      buildServer({ logger: false, security: { origins: ['https://matter.example/app'] } }),
    ).toThrow(/origin/i)
  })

  it('is not talked out of it by a wildcard', async () => {
    expect(() => buildServer({ logger: false, security: { origins: ['*'] } })).toThrow()
  })
})

describe('rate limiting the sign-in endpoints', () => {
  it('lets the first few through', async () => {
    const built = server()
    const codes: number[] = []
    for (const _ of [1, 2, 3]) {
      codes.push((await built.inject({ method: 'POST', url: '/auth/signout' })).statusCode)
    }

    expect(codes).not.toContain(429)
  })

  it('refuses the one after that', async () => {
    const built = server()
    for (const _ of [1, 2, 3]) await built.inject({ method: 'POST', url: '/auth/signout' })

    const response = await built.inject({ method: 'POST', url: '/auth/signout' })

    expect(response.statusCode).toBe(429)
  })

  it('says when to come back', async () => {
    const built = server()
    for (const _ of [1, 2, 3, 4]) await built.inject({ method: 'POST', url: '/auth/signout' })

    const response = await built.inject({ method: 'POST', url: '/auth/signout' })

    expect(Number(response.headers['retry-after'])).toBeGreaterThan(0)
  })

  it('still carries the cross-origin headers when it refuses', async () => {
    // **The one that would be missed.** A 429 the browser cannot read is reported to the page
    // as a CORS failure, so the application shows "something went wrong" instead of "you have
    // tried too many times, wait a minute" — and the user retries, which is the one thing the
    // limit was asking them not to do.
    const built = server()
    for (const _ of [1, 2, 3, 4]) {
      await built.inject({
        method: 'POST',
        url: '/auth/signout',
        headers: { origin: 'https://matter.example' },
      })
    }

    const response = await built.inject({
      method: 'POST',
      url: '/auth/signout',
      headers: { origin: 'https://matter.example' },
    })

    expect(response.statusCode).toBe(429)
    expect(response.headers['access-control-allow-origin']).toBe('https://matter.example')
  })

  it('still carries the security headers when it refuses', async () => {
    const built = server()
    for (const _ of [1, 2, 3, 4]) await built.inject({ method: 'POST', url: '/auth/signout' })

    const response = await built.inject({ method: 'POST', url: '/auth/signout' })

    expect(response.headers['x-content-type-options']).toBe('nosniff')
  })

  it('says nothing about why, beyond the fact', async () => {
    // Nothing about which limit, which window, or how many others there are. It is an
    // unauthenticated endpoint and every number is a hint about what else would work.
    const built = server()
    for (const _ of [1, 2, 3, 4]) await built.inject({ method: 'POST', url: '/auth/signout' })

    const response = await built.inject({ method: 'POST', url: '/auth/signout' })

    expect(JSON.parse(response.body)).toEqual({ error: 'too many requests' })
  })

  it('does not limit anything else', async () => {
    // Health checks run every few seconds forever, and the ordinary endpoints are protected by
    // needing a session rather than by a counter.
    const built = server()
    for (let index = 0; index < 20; index += 1) {
      await built.inject({ method: 'GET', url: '/healthz' })
    }

    expect((await built.inject({ method: 'GET', url: '/healthz' })).statusCode).toBe(200)
  })

  it('gives the token endpoint its own, larger budget', async () => {
    // They are used at completely different rates: signing in happens once, and a page refreshes
    // its access token for as long as it stays open. One shared budget would either throttle an
    // ordinary session or fail to throttle a sign-in attempt — so the test spends more than the
    // sign-in limit on the token endpoint, which only a separate limit permits.
    const built = server()
    const codes: number[] = []
    for (const _ of [1, 2, 3, 4, 5, 6]) {
      codes.push((await built.inject({ method: 'POST', url: '/auth/token' })).statusCode)
    }

    expect(codes).not.toContain(429)
  })

  it('counts each client separately', async () => {
    // Otherwise one noisy address locks everybody out of signing in, which is a denial of
    // service anybody can perform on everybody else with a loop.
    const built = server()
    for (const _ of [1, 2, 3, 4]) {
      await built.inject({ method: 'POST', url: '/auth/signout', remoteAddress: '10.0.0.1' })
    }

    const other = await built.inject({
      method: 'POST',
      url: '/auth/signout',
      remoteAddress: '10.0.0.2',
    })

    expect(other.statusCode).not.toBe(429)
  })

  it('cannot be sidestepped with a query string', async () => {
    // `POST /auth/signout?x=1` is the same endpoint. Keying on the whole URL would hand out a
    // fresh budget for every value anybody cared to invent, which is not a limit.
    const built = server()
    for (const _ of [1, 2, 3, 4]) await built.inject({ method: 'POST', url: '/auth/signout' })

    const response = await built.inject({ method: 'POST', url: '/auth/signout?x=1' })

    expect(response.statusCode).toBe(429)
  })
})

describe('what counts as a secure connection', () => {
  it('is not a proxy header nobody has been told to trust', async () => {
    // `trustProxy` is off unless a deployment sets it, and this has to follow that decision
    // rather than read the header itself: otherwise anyone can make this service claim, in an
    // HSTS header, that a plain connection was encrypted.
    const response = await server().inject({
      method: 'GET',
      url: '/healthz',
      headers: { 'x-forwarded-proto': 'https' },
    })

    expect(response.headers['strict-transport-security']).toBeUndefined()
  })

  it('is that header once a deployment says the proxy can be trusted', async () => {
    // The other half. A check that refused every proxy would be a check that turned HSTS off
    // for every real deployment, since production is always behind one.
    app = buildServer({ logger: false, trustProxy: true })
    const response = await app.inject({
      method: 'GET',
      url: '/healthz',
      headers: { 'x-forwarded-proto': 'https' },
    })

    expect(response.headers['strict-transport-security']).toContain('max-age=')
  })
})

describe('the body limit', () => {
  it('refuses a body larger than anything this service has', async () => {
    // Set in `buildServer` since the skeleton, and asserted here because a limit nobody has
    // watched refuse anything is a number in a constructor.
    const built = server()
    built.post('/big', async () => ({ ok: true }))

    const response = await built.inject({
      method: 'POST',
      url: '/big',
      headers: { 'content-type': 'application/json' },
      payload: JSON.stringify({ padding: 'x'.repeat(100 * 1024) }),
    })

    expect(response.statusCode).toBe(413)
  })

  it('accepts one that is merely large', async () => {
    const built = server()
    built.post('/big', async () => ({ ok: true }))

    const response = await built.inject({
      method: 'POST',
      url: '/big',
      headers: { 'content-type': 'application/json' },
      payload: JSON.stringify({ padding: 'x'.repeat(8 * 1024) }),
    })

    expect(response.statusCode).toBe(200)
  })
})
