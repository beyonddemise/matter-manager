import { generateKeyPairSync } from 'node:crypto'
import { afterEach, describe, expect, it } from 'vitest'
import { googleProvider } from '../../src/auth/google.js'
import { mintToken, signingKeyFromPem, verifyToken } from '../../src/auth/jwt.js'
import type { Identity } from '../../src/auth/oidc.js'
import { ACCESS_TOKEN_TTL } from '../../src/auth/routes.js'
import { buildServer, type Server } from '../../src/server.js'

function newKey(kid = 'ec-test') {
  const { privateKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' })
  return signingKeyFromPem(kid, privateKey.export({ type: 'pkcs8', format: 'pem' }).toString())
}

const IDENTITY: Identity = { sub: 'google|1234', email: 'ada@example.com', name: 'Ada' }

let app: Server | undefined

afterEach(async () => {
  await app?.close()
  app = undefined
})

/** The service with sign-in wired to a provider that is not Google. */
function signInServer(
  overrides: {
    verifyIdToken?: (idToken: string) => Promise<Identity>
    remembered?: Identity[]
    rememberUser?: (identity: Identity) => Promise<void>
    exchange?: typeof fetch
  } = {},
) {
  const key = newKey()
  const remembered = overrides.remembered ?? []

  app = buildServer({
    logger: false,
    auth: {
      provider: googleProvider({
        clientId: 'client-123',
        clientSecret: 'secret',
        redirectUri: 'https://matter.example/auth/google/callback',
      }),
      key,
      verifyIdToken: overrides.verifyIdToken ?? (async () => IDENTITY),
      appOrigin: 'https://matter.example',
      // The provider's token endpoint, faked. Letting this reach Google would be a test that
      // needs credentials, a network and a real user — and therefore a test nobody runs.
      fetchImpl:
        overrides.exchange ??
        ((async () =>
          ({
            ok: true,
            status: 200,
            json: async () => ({ id_token: 'header.payload.signature' }),
          }) as unknown as Response) as unknown as typeof fetch),
      rememberUser:
        overrides.rememberUser ??
        (async (identity) => {
          remembered.push(identity)
        }),
    },
  })
  return { app, key, remembered }
}

/** Every `Set-Cookie` on a reply, as strings. */
const cookies = (headers: Record<string, unknown>): string[] => {
  const raw = headers['set-cookie']
  return Array.isArray(raw) ? raw.map(String) : raw === undefined ? [] : [String(raw)]
}

const cookieNamed = (headers: Record<string, unknown>, name: string): string | undefined =>
  cookies(headers).find((entry) => entry.startsWith(`${name}=`))

/** The value of a cookie, decoded. */
const cookieValue = (entry: string): string =>
  decodeURIComponent(entry.slice(entry.indexOf('=') + 1).split(';')[0] ?? '')

describe('offering sign-in', () => {
  it('is absent when no provider is configured', async () => {
    // Rather than registering a route that answers with a misconfiguration error at the moment
    // a user presses the button. Absent means absent, and the drift check agrees it is
    // unimplemented — which is true.
    app = buildServer({ logger: false })

    expect(await app.inject({ method: 'GET', url: '/auth/google' })).toMatchObject({
      statusCode: 404,
    })
  })

  it('redirects to the provider', async () => {
    const { app: server } = signInServer()
    const response = await server.inject({ method: 'GET', url: '/auth/google' })

    expect(response.statusCode).toBe(302)
    expect(response.headers.location).toContain('accounts.google.com')
  })

  it('sets the flow carrier as an httpOnly cookie', async () => {
    // The issue's rule: tokens never in `localStorage`. The PKCE verifier is the strictest case
    // — the page has no reason to read it, so it is put somewhere the page cannot.
    const { app: server } = signInServer()
    const response = await server.inject({ method: 'GET', url: '/auth/google' })
    const flow = cookieNamed(response.headers as Record<string, unknown>, 'mm_flow')

    expect(flow).toBeDefined()
    expect(flow).toContain('HttpOnly')
    expect(flow).toContain('SameSite=Lax')
  })

  it('uses SameSite=Lax, because the callback is a cross-site navigation', async () => {
    // `Strict` withholds cookies on exactly the navigation Google performs, so sign-in would
    // fail only in production, only after a real redirect, with a state error that looks like a
    // bug in the state check.
    const { app: server } = signInServer()
    const response = await server.inject({ method: 'GET', url: '/auth/google' })

    expect(cookieNamed(response.headers as Record<string, unknown>, 'mm_flow')).not.toContain(
      'SameSite=Strict',
    )
  })

  it('keeps the verifier out of the redirect', async () => {
    const { app: server } = signInServer()
    const response = await server.inject({ method: 'GET', url: '/auth/google' })
    const carrier = cookieValue(
      cookieNamed(response.headers as Record<string, unknown>, 'mm_flow') ?? '',
    )
    const flow = JSON.parse(Buffer.from(carrier.split('.')[1] ?? '', 'base64url').toString())

    expect(String(response.headers.location)).not.toContain(flow.verifier)
  })
})

describe('completing sign-in', () => {
  /** Runs a whole sign-in and returns the callback's reply. */
  async function signIn(overrides: Parameters<typeof signInServer>[0] = {}) {
    const built = signInServer(overrides)
    const start = await built.app.inject({ method: 'GET', url: '/auth/google' })
    const carrier = cookieNamed(start.headers as Record<string, unknown>, 'mm_flow') ?? ''
    const state = new URL(String(start.headers.location)).searchParams.get('state') ?? ''

    const callback = await built.app.inject({
      method: 'GET',
      url: `/auth/google/callback?code=the-code&state=${encodeURIComponent(state)}`,
      headers: { cookie: carrier.split(';')[0] ?? '' },
    })
    return { ...built, callback }
  }

  it('returns the user to the application with a session', async () => {
    const { callback, key } = await signIn()

    expect(callback.statusCode).toBe(302)
    expect(callback.headers.location).toBe('https://matter.example/')

    const session = cookieNamed(callback.headers as Record<string, unknown>, 'mm_session')
    expect(session).toContain('HttpOnly')
    expect(verifyToken(cookieValue(session ?? ''), key.publicKey).sub).toBe('google|1234')
  })

  it('records the user', async () => {
    // The issue's first scenario: "a profile document is created". This is the seam that does
    // it; M4-5 fills in what the document contains.
    const { remembered } = await signIn()

    expect(remembered).toEqual([IDENTITY])
  })

  it('clears the flow carrier once it is spent', async () => {
    // A PKCE verifier that outlives its exchange is a credential lying around for no reason.
    const { callback } = await signIn()

    expect(cookieNamed(callback.headers as Record<string, unknown>, 'mm_flow')).toContain(
      'Max-Age=0',
    )
  })

  it('records the user before issuing the session, not after', async () => {
    // The right way round. A signed-in user whose profile does not exist would fail on their
    // next request in a way nothing explains; a failed sign-in they can simply repeat.
    const { callback } = await signIn({
      rememberUser: async () => {
        throw new Error('storage is down')
      },
    })

    expect(callback.headers.location).toContain('signin=failed')
    expect(cookieNamed(callback.headers as Record<string, unknown>, 'mm_session')).toContain(
      'Max-Age=0',
    )
  })
})

describe('abandoning sign-in', () => {
  it('returns the user signed out, with nothing created', async () => {
    // The issue's third scenario. Google sends `error=access_denied` when the user presses
    // Cancel, and nothing has been written by that point — so there is no partial account to
    // clean up, which is a property of the ordering rather than of a cleanup step.
    const { app: server, remembered } = signInServer()
    const response = await server.inject({
      method: 'GET',
      url: '/auth/google/callback?error=access_denied&state=whatever',
    })

    expect(response.statusCode).toBe(302)
    expect(response.headers.location).toBe('https://matter.example/')
    expect(response.headers.location).not.toContain('failed')
    expect(remembered).toEqual([])
    expect(cookieNamed(response.headers as Record<string, unknown>, 'mm_session')).toContain(
      'Max-Age=0',
    )
  })

  it('does not report a cancelled sign-in as a failure', async () => {
    // The user made a choice. Telling them it went wrong is the application arguing with them.
    const { app: server } = signInServer()
    const response = await server.inject({
      method: 'GET',
      url: '/auth/google/callback?error=access_denied&state=x',
    })

    expect(String(response.headers.location)).not.toContain('signin=failed')
  })
})

describe('a callback that was not started here', () => {
  it('is refused when the state does not match', async () => {
    // CSRF: an attacker walks a victim's browser through *their* sign-in, and the victim ends
    // up signed in as the attacker in an application holding their home's commissioning codes.
    const { app: server, remembered } = signInServer()
    const start = await server.inject({ method: 'GET', url: '/auth/google' })
    const carrier = cookieNamed(start.headers as Record<string, unknown>, 'mm_flow') ?? ''

    const response = await server.inject({
      method: 'GET',
      url: '/auth/google/callback?code=c&state=not-the-state',
      headers: { cookie: carrier.split(';')[0] ?? '' },
    })

    expect(response.headers.location).toContain('signin=failed')
    expect(remembered).toEqual([])
  })

  it('is refused when there is no carrier at all', async () => {
    const { app: server } = signInServer()
    const response = await server.inject({
      method: 'GET',
      url: '/auth/google/callback?code=c&state=s',
    })

    expect(response.headers.location).toContain('signin=failed')
  })
})

describe('issuing an access token', () => {
  async function signedIn() {
    const built = signInServer()
    const start = await built.app.inject({ method: 'GET', url: '/auth/google' })
    const carrier = cookieNamed(start.headers as Record<string, unknown>, 'mm_flow') ?? ''
    const state = new URL(String(start.headers.location)).searchParams.get('state') ?? ''
    const callback = await built.app.inject({
      method: 'GET',
      url: `/auth/google/callback?code=c&state=${encodeURIComponent(state)}`,
      headers: { cookie: carrier.split(';')[0] ?? '' },
    })
    const session = cookieNamed(callback.headers as Record<string, unknown>, 'mm_session') ?? ''
    return { ...built, sessionCookie: session.split(';')[0] ?? '' }
  }

  it('answers what the contract declares', async () => {
    const { app: server, sessionCookie, key } = await signedIn()
    const response = await server.inject({
      method: 'POST',
      url: '/auth/token',
      headers: { cookie: sessionCookie },
    })

    expect(response.statusCode).toBe(200)
    const body = response.json() as { accessToken: string; expiresIn: number }
    expect(body.expiresIn).toBe(ACCESS_TOKEN_TTL)
    expect(verifyToken(body.accessToken, key.publicKey).sub).toBe('google|1234')
  })

  it('returns the token in the body rather than a cookie', async () => {
    // Deliberate, and the one place a token is readable by the page: PouchDB has to put it in
    // an Authorization header, so it cannot be httpOnly. In memory it dies with the tab; in
    // `localStorage` it survives and is readable by any script that ever runs on the origin.
    const { app: server, sessionCookie } = await signedIn()
    const response = await server.inject({
      method: 'POST',
      url: '/auth/token',
      headers: { cookie: sessionCookie },
    })

    expect(cookies(response.headers as Record<string, unknown>)).toEqual([])
    expect(response.json()).toHaveProperty('accessToken')
  })

  it('is never cached', async () => {
    // A token in a shared cache is a token for whoever asks next.
    const { app: server, sessionCookie } = await signedIn()
    const response = await server.inject({
      method: 'POST',
      url: '/auth/token',
      headers: { cookie: sessionCookie },
    })

    expect(response.headers['cache-control']).toBe('no-store')
  })

  it('refuses without a session', async () => {
    const { app: server } = signInServer()

    expect((await server.inject({ method: 'POST', url: '/auth/token' })).statusCode).toBe(401)
  })

  it('refuses a session signed by somebody else', async () => {
    // A well-formed, unexpired, correctly-shaped token — signed with a key this service has
    // never seen. If the signature were not checked, this would mint a CouchDB token for
    // whatever `sub` the forger chose, which is direct access to that user's database.
    const { app: server } = signInServer()
    const forged = mintToken(newKey('someone-elses-key'), {
      sub: 'google|victim',
      exp: Math.floor(Date.now() / 1000) + 3600,
    })

    const response = await server.inject({
      method: 'POST',
      url: '/auth/token',
      headers: { cookie: `mm_session=${encodeURIComponent(forged)}` },
    })

    expect(response.statusCode).toBe(401)
  })

  it('refuses an expired session', async () => {
    const { app: server, key } = signInServer()
    const stale = mintToken(key, { sub: 'google|1234', exp: 1000 })

    const response = await server.inject({
      method: 'POST',
      url: '/auth/token',
      headers: { cookie: `mm_session=${encodeURIComponent(stale)}` },
    })

    expect(response.statusCode).toBe(401)
  })

  it('refuses a session claiming alg none', async () => {
    // The classic. `verifySession` deliberately reuses the same verification a CouchDB token
    // gets, so the algorithm guard applies here too — and a session cookie is exactly the token
    // an attacker would most like to present unsigned.
    const { app: server } = signInServer()
    const header = Buffer.from(JSON.stringify({ alg: 'none', typ: 'JWT' })).toString('base64url')
    const payload = Buffer.from(
      JSON.stringify({ sub: 'google|victim', exp: Math.floor(Date.now() / 1000) + 3600 }),
    ).toString('base64url')

    const response = await server.inject({
      method: 'POST',
      url: '/auth/token',
      headers: { cookie: `mm_session=${encodeURIComponent(`${header}.${payload}.`)}` },
    })

    expect(response.statusCode).toBe(401)
  })
})
