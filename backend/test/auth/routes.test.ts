import { generateKeyPairSync } from 'node:crypto'
import { afterEach, describe, expect, it } from 'vitest'
import { denyList } from '../../src/auth/deny-list.js'
import { googleProvider } from '../../src/auth/google.js'
import { mintToken, signingKeyFromPem, verifyToken } from '../../src/auth/jwt.js'
import type { Identity } from '../../src/auth/oidc.js'
import { hashJti, refreshStore } from '../../src/auth/refresh-store.js'
import { ACCESS_TOKEN_TTL, type AuthDependencies } from '../../src/auth/routes.js'
import { buildServer, type Server } from '../../src/server.js'
import { forgetUsersDatabase } from '../../src/users/database.js'
import { recordEnsurer } from '../../src/users/ensure.js'
import { userRecords } from '../../src/users/records.js'
import { fakeCouch } from '../support/couch.js'

function newKey(kid = 'ec-test') {
  const { privateKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' })
  return signingKeyFromPem(kid, privateKey.export({ type: 'pkcs8', format: 'pem' }).toString())
}

const VERIFIED: Identity = {
  sub: 'google|1234',
  email: 'ada@example.com',
  emailVerified: true,
  name: 'Ada',
}

/** The test clock's starting point. Every verification below reads the same instant. */
const T0 = 1_800_000_000
const at = () => T0

let app: Server | undefined

afterEach(async () => {
  await app?.close()
  app = undefined
})

/** The service with sign-in wired to a fake provider and a fake CouchDB. */
function signInServer(
  overrides: {
    identity?: Identity
    signIn?: AuthDependencies['signIn']
    exchange?: typeof fetch
    /**
     * Also wire `/profile` over the same key, records and deny list, so a test can present the
     * access token this service really mints rather than one a helper built to look like it.
     */
    withProfile?: boolean
  } = {},
) {
  forgetUsersDatabase()
  let t = T0
  const now = () => t
  // Mutable and held by reference, so a test can make CouchDB fail after the record exists.
  const fails: { putDoc?: string } = {}
  const fake = fakeCouch({ fails })
  const records = userRecords(fake.couch)
  const refresh = refreshStore(records, now)
  const deny = denyList(now)
  const logged: unknown[] = []
  const signedIn: Identity[] = []
  const key = newKey()
  // A *different* key, and that is the entire point of it. See the key-isolation tests below.
  const sessionKey = newKey('ec-session')
  // Who the provider says signed in. Mutable, so one test can sign in twice as two people.
  let identity = overrides.identity ?? VERIFIED
  app = buildServer({
    logger: false,
    auth: {
      provider: googleProvider({
        clientId: 'c',
        clientSecret: 's',
        redirectUri: 'https://matter.example/auth/google/callback',
      }),
      key,
      sessionKey,
      verifyIdToken: async () => identity,
      appOrigin: 'https://matter.example',
      // The provider's token endpoint, faked. Letting this reach Google would be a test that
      // needs credentials, a network and a real user — and therefore a test nobody runs.
      fetchImpl:
        overrides.exchange ??
        ((async () => ({
          ok: true,
          status: 200,
          json: async () => ({ id_token: 'h.p.s' }),
        })) as unknown as typeof fetch),
      records,
      refresh,
      deny,
      signIn:
        overrides.signIn ??
        (async (identity) => {
          signedIn.push(identity)
          return { hasRecord: false }
        }),
      logSignIn: (event) => logged.push(event),
      now,
    },
    ...(overrides.withProfile === true
      ? { profile: { records, ensureRecord: recordEnsurer(records, refresh), key, deny, now } }
      : {}),
  })
  return {
    app,
    key,
    sessionKey,
    records,
    refresh,
    deny,
    fake,
    fails,
    logged,
    signedIn,
    /** Makes the next sign-in somebody else's. */
    signInAs: (next: Identity) => {
      identity = next
    },
    advance: (s: number) => {
      t += s
    },
  }
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

/** Runs the redirect dance and returns the callback's reply. */
async function callback(server: ReturnType<typeof signInServer>) {
  const start = await server.app.inject({ method: 'GET', url: '/auth/google' })
  const flow = cookieNamed(start.headers, 'mm_flow') ?? ''
  const state = new URL(String(start.headers.location)).searchParams.get('state') ?? ''
  return server.app.inject({
    method: 'GET',
    url: `/auth/google/callback?code=c&state=${encodeURIComponent(state)}`,
    headers: { cookie: `mm_flow=${encodeURIComponent(cookieValue(flow))}` },
  })
}

/** Runs the redirect dance and returns the handoff cookie header to send to /auth/token. */
async function completeSignIn(server: ReturnType<typeof signInServer>): Promise<string> {
  const reply = await callback(server)
  const handoff = cookieNamed(reply.headers, 'mm_handoff')
  if (handoff === undefined) throw new Error('no handoff cookie')
  return `mm_handoff=${encodeURIComponent(cookieValue(handoff))}`
}

/** Signs in and exchanges the handoff, returning the token pair. */
async function tokensFor(server: ReturnType<typeof signInServer>) {
  const cookie = await completeSignIn(server)
  const reply = await server.app.inject({ method: 'POST', url: '/auth/token', headers: { cookie } })
  return reply.json() as { accessToken: string; expiresIn: number; refreshToken: string }
}

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
    // The PKCE verifier is the strictest case — the page has no reason to read it, so it is put
    // somewhere the page cannot.
    const { app: server } = signInServer()
    const response = await server.inject({ method: 'GET', url: '/auth/google' })
    const flow = cookieNamed(response.headers, 'mm_flow')

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

    expect(cookieNamed(response.headers, 'mm_flow')).not.toContain('SameSite=Strict')
  })

  it('keeps the verifier out of the redirect', async () => {
    const { app: server } = signInServer()
    const response = await server.inject({ method: 'GET', url: '/auth/google' })
    const carrier = cookieValue(cookieNamed(response.headers, 'mm_flow') ?? '')
    const flow = JSON.parse(Buffer.from(carrier.split('.')[1] ?? '', 'base64url').toString())

    expect(String(response.headers.location)).not.toContain(flow.verifier)
  })
})

describe('completing sign-in', () => {
  it('returns the user to the application with a handoff cookie', async () => {
    const server = signInServer()
    const reply = await callback(server)

    expect(reply.statusCode).toBe(302)
    expect(reply.headers.location).toBe('https://matter.example/')

    const handoff = cookieNamed(reply.headers, 'mm_handoff')
    expect(handoff).toContain('HttpOnly')
    expect(handoff).toContain('SameSite=Lax')
    expect(handoff).toContain('Max-Age=120')
    expect(
      verifyToken(cookieValue(handoff ?? ''), server.sessionKey.publicKey, 'handoff', at),
    ).toMatchObject({ sub: 'google|1234', email: 'ada@example.com', name: 'Ada' })
  })

  it('sets no session cookie any more', async () => {
    const reply = await callback(signInServer())

    expect(cookieNamed(reply.headers, 'mm_session')).toBeUndefined()
  })

  it('hands the verified identity to signIn', async () => {
    const server = signInServer()
    await callback(server)

    expect(server.signedIn).toEqual([VERIFIED])
  })

  it('clears the flow carrier once it is spent', async () => {
    // A PKCE verifier that outlives its exchange is a credential lying around for no reason.
    const reply = await callback(signInServer())

    expect(cookieNamed(reply.headers, 'mm_flow')).toContain('Max-Age=0')
  })

  it('issues no handoff when signIn fails', async () => {
    // The right way round. A failed sign-in the user can simply repeat; a handoff for somebody
    // whose invitations were half-accepted is a state nothing explains.
    const reply = await callback(
      signInServer({
        signIn: async () => {
          throw new Error('storage is down')
        },
      }),
    )

    expect(reply.headers.location).toContain('signin=failed')
    expect(cookieNamed(reply.headers, 'mm_handoff')).toContain('Max-Age=0')
  })
})

describe('sign-in creates no record', () => {
  it('logs one line and writes nothing to matter_manager', async () => {
    const server = signInServer()
    await completeSignIn(server)
    expect(server.logged).toEqual([
      { sub: 'google|1234', email: 'ada@example.com', provider: 'google', hasRecord: false },
    ])
    expect(
      [...server.fake.documents.keys()].some((k) => k.startsWith('matter_manager/user:')),
    ).toBe(false)
  })

  it('refuses an unverified address', async () => {
    // Records are keyed by the address, so an address the provider did not vouch for would let
    // somebody sign in as whoever they typed.
    const server = signInServer({ identity: { ...VERIFIED, emailVerified: false } })
    const reply = await callback(server)

    expect(String(reply.headers.location)).toContain('signin=failed')
    expect(cookieValue(cookieNamed(reply.headers, 'mm_handoff') ?? '')).toBe('')
    expect(server.signedIn).toEqual([])
    expect(server.logged).toEqual([])
  })

  it('refuses an identity with no address at all', async () => {
    const server = signInServer({ identity: { sub: 'google|1234', emailVerified: true } })
    const reply = await callback(server)

    expect(String(reply.headers.location)).toContain('signin=failed')
    expect(server.signedIn).toEqual([])
  })
})

describe('abandoning sign-in', () => {
  it('returns the user signed out, with nothing created', async () => {
    // Google sends `error=access_denied` when the user presses Cancel, and nothing has been
    // written by that point — so there is no partial account to clean up, which is a property
    // of the ordering rather than of a cleanup step.
    const server = signInServer()
    const response = await server.app.inject({
      method: 'GET',
      url: '/auth/google/callback?error=access_denied&state=whatever',
    })

    expect(response.statusCode).toBe(302)
    expect(response.headers.location).toBe('https://matter.example/')
    expect(server.signedIn).toEqual([])
    expect(server.logged).toEqual([])
    expect(cookieNamed(response.headers, 'mm_handoff')).toContain('Max-Age=0')
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
    // up signed in as the attacker.
    const server = signInServer()
    const start = await server.app.inject({ method: 'GET', url: '/auth/google' })
    const carrier = cookieNamed(start.headers, 'mm_flow') ?? ''

    const response = await server.app.inject({
      method: 'GET',
      url: '/auth/google/callback?code=c&state=not-the-state',
      headers: { cookie: carrier.split(';')[0] ?? '' },
    })

    expect(response.headers.location).toContain('signin=failed')
    expect(server.signedIn).toEqual([])
    expect(cookieValue(cookieNamed(response.headers, 'mm_handoff') ?? '')).toBe('')
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

describe('POST /auth/token', () => {
  it('exchanges the handoff cookie for both tokens, once', async () => {
    const server = signInServer()
    const cookie = await completeSignIn(server)
    const first = await server.app.inject({
      method: 'POST',
      url: '/auth/token',
      headers: { cookie },
    })
    expect(first.statusCode).toBe(200)
    const body = first.json()
    expect(body).toMatchObject({ expiresIn: 300 })
    expect(ACCESS_TOKEN_TTL).toBe(300)
    expect(typeof body.refreshToken).toBe('string')

    const access = verifyToken(body.accessToken, server.key.publicKey, 'access', at)
    expect(access).toMatchObject({
      sub: 'google|1234',
      email: 'ada@example.com',
      '_couchdb.roles': ['free'],
    })
    expect(typeof access.jti).toBe('string')

    const replay = await server.app.inject({
      method: 'POST',
      url: '/auth/token',
      headers: { cookie },
    })
    expect(replay.statusCode).toBe(401)
  })

  it('clears the handoff cookie once it is spent', async () => {
    const server = signInServer()
    const cookie = await completeSignIn(server)
    const reply = await server.app.inject({
      method: 'POST',
      url: '/auth/token',
      headers: { cookie },
    })

    expect(cookieNamed(reply.headers, 'mm_handoff')).toContain('Max-Age=0')
  })

  it('refuses a handoff after its two minutes', async () => {
    const server = signInServer()
    const cookie = await completeSignIn(server)
    server.advance(120)

    const reply = await server.app.inject({
      method: 'POST',
      url: '/auth/token',
      headers: { cookie },
    })
    expect(reply.statusCode).toBe(401)
  })

  it('refuses a handoff minted to live longer than its two minutes', async () => {
    // The cookie is only as short-lived as the token inside it says. A handoff minted with a long
    // `exp` (by a probe, or by a bug) would otherwise be a long-lived credential, so the lifetime
    // is checked against `iat` as well as against the clock.
    const server = signInServer()
    const mint = (claims: { iat?: number; exp: number }) =>
      mintToken(server.sessionKey, {
        purpose: 'handoff',
        sub: 'google|1234',
        email: 'ada@example.com',
        jti: crypto.randomUUID(),
        ...claims,
      })
    const exchange = async (handoff: string) =>
      (
        await server.app.inject({
          method: 'POST',
          url: '/auth/token',
          headers: { cookie: `mm_handoff=${encodeURIComponent(handoff)}` },
        })
      ).statusCode

    expect(await exchange(mint({ iat: T0, exp: T0 + 600 }))).toBe(401)
    expect(await exchange(mint({ exp: T0 + 120 }))).toBe(401)
    expect(await exchange(mint({ iat: T0 + 3600, exp: T0 + 3660 }))).toBe(401)
    expect(await exchange(mint({ iat: T0, exp: T0 + 120 }))).toBe(200)
  })

  it('refreshes with the refresh token, returning the same refresh token', async () => {
    const server = signInServer()
    const first = await tokensFor(server)
    const again = await server.app.inject({
      method: 'POST',
      url: '/auth/token',
      payload: { refreshToken: first.refreshToken },
    })
    expect(again.statusCode).toBe(200)
    expect(again.json().refreshToken).toBe(first.refreshToken)
  })

  it('carries a plan an operator set since the last refresh, without signing in again', async () => {
    const server = signInServer()
    const first = await tokensFor(server)
    await server.records.setPlan('ada@example.com', 'pro')
    const again = (
      await server.app.inject({
        method: 'POST',
        url: '/auth/token',
        payload: { refreshToken: first.refreshToken },
      })
    ).json()
    const claims = verifyToken(again.accessToken, server.key.publicKey, 'access', at)
    expect(claims['_couchdb.roles']).toEqual(['pro'])
  })

  it('refuses a refresh token whose hash an admin deleted from the record', async () => {
    const server = signInServer()
    const first = await tokensFor(server)
    await recordEnsurer(
      server.records,
      server.refresh,
    )({
      email: 'ada@example.com',
      sub: 'google|1234',
    })
    const { jti } = verifyToken(first.refreshToken, server.sessionKey.publicKey, 'refresh', at)
    await server.records.removeRefresh('ada@example.com', hashJti(String(jti)))
    const again = await server.app.inject({
      method: 'POST',
      url: '/auth/token',
      payload: { refreshToken: first.refreshToken },
    })
    expect(again.statusCode).toBe(401)
  })

  it('refuses a refresh token whose own expiry has passed, though its hash is still stored', async () => {
    // The signature check and the store check are separate gates. Here the store would say yes,
    // so only the token's `exp` can be what refuses it.
    const server = signInServer()
    const expired = mintToken(server.sessionKey, {
      purpose: 'refresh',
      sub: 'google|1234',
      email: 'ada@example.com',
      jti: 'expired-claim',
      iat: T0 - 7200,
      exp: T0 - 1,
    })
    await server.records.ensure({ email: 'ada@example.com', sub: 'google|1234' }, [
      { hash: hashJti('expired-claim'), exp: T0 + 3600, createdAt: T0 - 7200 },
    ])

    const reply = await server.app.inject({
      method: 'POST',
      url: '/auth/token',
      payload: { refreshToken: expired },
    })
    expect(reply.statusCode).toBe(401)
  })

  it('refuses a valid refresh token whose stored entry on the record has expired', async () => {
    // The other way round: the token verifies, and the record still lists its hash, but the
    // entry's own `exp` has passed. An entry is honoured only while it is unexpired.
    const server = signInServer()
    const live = mintToken(server.sessionKey, {
      purpose: 'refresh',
      sub: 'google|1234',
      email: 'ada@example.com',
      jti: 'expired-entry',
      iat: T0 - 7200,
      exp: T0 + 3600,
    })
    await server.records.ensure({ email: 'ada@example.com', sub: 'google|1234' }, [
      { hash: hashJti('expired-entry'), exp: T0 - 1, createdAt: T0 - 7200 },
    ])

    const reply = await server.app.inject({
      method: 'POST',
      url: '/auth/token',
      payload: { refreshToken: live },
    })
    expect(reply.statusCode).toBe(401)
  })

  it('refuses an access token presented as a refresh token', async () => {
    // The access token is handed to page scripts on purpose. If it also worked as a refresh
    // token, exfiltrating one would mint fresh access tokens for as long as the thief asked.
    const server = signInServer()
    const first = await tokensFor(server)
    const again = await server.app.inject({
      method: 'POST',
      url: '/auth/token',
      payload: { refreshToken: first.accessToken },
    })
    expect(again.statusCode).toBe(401)
  })

  it('refuses a handoff presented as a refresh token', async () => {
    // Same key, different purpose: the claim is what keeps a two-minute bridge from being
    // replayed as a thirty-day credential.
    const server = signInServer()
    const cookie = await completeSignIn(server)
    const handoff = decodeURIComponent(cookie.slice('mm_handoff='.length))
    const again = await server.app.inject({
      method: 'POST',
      url: '/auth/token',
      payload: { refreshToken: handoff },
    })
    expect(again.statusCode).toBe(401)
  })

  it('refuses a refresh token presented as the handoff cookie', async () => {
    const server = signInServer()
    const { refreshToken } = await tokensFor(server)
    const again = await server.app.inject({
      method: 'POST',
      url: '/auth/token',
      headers: { cookie: `mm_handoff=${encodeURIComponent(refreshToken)}` },
    })
    expect(again.statusCode).toBe(401)
  })

  it('refuses a refresh token signed by somebody else', async () => {
    // Well-formed, unexpired, correctly shaped — and signed with a key this service has never
    // seen. Without the signature check this mints a CouchDB token for whoever the forger chose.
    const server = signInServer()
    const forged = mintToken(newKey('someone-elses-key'), {
      purpose: 'refresh',
      sub: 'google|victim',
      email: 'victim@example.com',
      jti: 'j',
      exp: T0 + 3600,
    })
    const again = await server.app.inject({
      method: 'POST',
      url: '/auth/token',
      payload: { refreshToken: forged },
    })
    expect(again.statusCode).toBe(401)
  })

  it('refuses a refresh token claiming alg none', async () => {
    const server = signInServer()
    const header = Buffer.from(JSON.stringify({ alg: 'none', typ: 'JWT' })).toString('base64url')
    const payload = Buffer.from(
      JSON.stringify({ purpose: 'refresh', sub: 'google|victim', exp: T0 + 3600 }),
    ).toString('base64url')
    const again = await server.app.inject({
      method: 'POST',
      url: '/auth/token',
      payload: { refreshToken: `${header}.${payload}.` },
    })
    expect(again.statusCode).toBe(401)
  })

  it('refuses a refreshToken that is not a token when there is no handoff to honour', async () => {
    // R11. A caller that sent *something* meant to refresh, and with no fresh sign-in behind
    // it there is nothing else to honour: the malformed token is the request, and it fails.
    const server = signInServer()
    for (const refreshToken of [123, '', null, { token: 'x' }]) {
      const reply = await server.app.inject({
        method: 'POST',
        url: '/auth/token',
        payload: { refreshToken },
      })
      expect(reply.statusCode, JSON.stringify(refreshToken)).toBe(401)
    }
  })

  it('honours a handoff that verifies whatever the body holds', async () => {
    // The handoff means a sign-in finished seconds ago, which is newer than anything the page
    // kept. The page sends its stored refresh token on every call, so a malformed or stale one
    // there must not turn the sign-in that just happened into "session ended".
    const server = signInServer()
    for (const refreshToken of [123, '', null, { token: 'x' }, 'not.a.token']) {
      const cookie = await completeSignIn(server)
      const reply = await server.app.inject({
        method: 'POST',
        url: '/auth/token',
        headers: { cookie },
        payload: { refreshToken },
      })
      expect(reply.statusCode, JSON.stringify(refreshToken)).toBe(200)
    }
  })

  it('prefers a fresh handoff over a stored refresh token that has been revoked', async () => {
    // The case that produced an immediate "session ended": sign-out revoked the token on the
    // server but could not remove it from this device, the user signed in again, and the page
    // sent the dead token alongside the new handoff.
    const server = signInServer()
    const stale = await tokensFor(server)
    await server.app.inject({
      method: 'POST',
      url: '/auth/signout',
      payload: { refreshToken: stale.refreshToken },
    })
    const cookie = await completeSignIn(server)

    const reply = await server.app.inject({
      method: 'POST',
      url: '/auth/token',
      headers: { cookie },
      payload: { refreshToken: stale.refreshToken },
    })

    expect(reply.statusCode).toBe(200)
    expect(reply.json().refreshToken).not.toBe(stale.refreshToken)
    expect(cookieNamed(reply.headers, 'mm_handoff')).toContain('Max-Age=0')
  })

  it('prefers a fresh handoff over a live refresh token for somebody else', async () => {
    // Signing in as another account on a device that still holds the first one's token. The
    // sign-in is the user's latest intent; answering for the old account would put them back in
    // it without asking.
    const server = signInServer()
    const first = await tokensFor(server)
    server.signInAs({
      sub: 'google|5678',
      email: 'grace@example.com',
      emailVerified: true,
      name: 'Grace',
    })
    const cookie = await completeSignIn(server)

    const reply = await server.app.inject({
      method: 'POST',
      url: '/auth/token',
      headers: { cookie },
      payload: { refreshToken: first.refreshToken },
    })

    expect(reply.statusCode).toBe(200)
    const access = verifyToken(reply.json().accessToken, server.key.publicKey, 'access', at)
    expect(access).toMatchObject({ sub: 'google|5678', email: 'grace@example.com' })
  })

  it('falls back to the body refresh token when the handoff no longer verifies', async () => {
    // A handoff cookie that is spent or expired is not a sign-in that just happened, so the
    // stored refresh token is the request — exactly as if no cookie had been sent.
    const server = signInServer()
    const cookie = await completeSignIn(server)
    const tokens = (
      await server.app.inject({ method: 'POST', url: '/auth/token', headers: { cookie } })
    ).json()

    const reply = await server.app.inject({
      method: 'POST',
      url: '/auth/token',
      headers: { cookie },
      payload: { refreshToken: tokens.refreshToken },
    })

    expect(reply.statusCode).toBe(200)
    expect(reply.json().refreshToken).toBe(tokens.refreshToken)
  })

  it('refuses with neither a handoff nor a refresh token', async () => {
    const { app: server } = signInServer()

    const response = await server.inject({ method: 'POST', url: '/auth/token' })
    expect(response.statusCode).toBe(401)
    expect(response.headers['content-type']).toMatch(/^application\/problem\+json/)
  })

  it('is never cached', async () => {
    // A token in a shared cache is a token for whoever asks next.
    const server = signInServer()
    const cookie = await completeSignIn(server)
    const response = await server.app.inject({
      method: 'POST',
      url: '/auth/token',
      headers: { cookie },
    })

    expect(response.headers['cache-control']).toBe('no-store')
  })
})

describe('the access token carries the provider name', () => {
  // A record-less profile is built from the access token's claims, and `PATCH /profile` seeds a
  // new record from them. Without `name` in the token both fell back to the provider subject:
  // a person who had only signed in was greeted as `google|1234`.
  it('carries name in the access token itself', async () => {
    const server = signInServer()
    const { accessToken } = await tokensFor(server)

    expect(verifyToken(accessToken, server.key.publicKey, 'access', at).name).toBe('Ada')
  })

  it('shows the provider name on a record-less profile', async () => {
    const server = signInServer({ withProfile: true })
    const { accessToken } = await tokensFor(server)
    const response = await server.app.inject({
      method: 'GET',
      url: '/profile',
      headers: { authorization: `Bearer ${accessToken}` },
    })

    expect(response.statusCode).toBe(200)
    expect(response.json().displayName).toBe('Ada')
  })

  it('seeds the new record with the provider name on the first PATCH /profile', async () => {
    const server = signInServer({ withProfile: true })
    const { accessToken } = await tokensFor(server)
    const response = await server.app.inject({
      method: 'PATCH',
      url: '/profile',
      headers: { authorization: `Bearer ${accessToken}` },
      payload: { locale: 'de' },
    })

    expect(response.statusCode).toBe(200)
    expect((await server.records.read('ada@example.com'))?.displayName).toBe('Ada')
  })

  it('omits name when the provider gave none', async () => {
    const { name: _unused, ...nameless } = VERIFIED
    const server = signInServer({ identity: nameless })
    const { accessToken } = await tokensFor(server)

    expect(verifyToken(accessToken, server.key.publicKey, 'access', at)).not.toHaveProperty('name')
  })
})

describe('which key signs what', () => {
  it('signs the handoff and the refresh token with a key CouchDB does not have', async () => {
    // **CouchDB does not evaluate `purpose`** — it checks a signature and an expiry, using the
    // public key this service installs in `[jwt_keys]`. A thirty-day refresh token signed with
    // that key would be a thirty-day database credential however carefully this service refused
    // it. A key CouchDB has never been given is what closes that.
    const server = signInServer()
    const cookie = await completeSignIn(server)
    const handoff = decodeURIComponent(cookie.slice('mm_handoff='.length))
    const { refreshToken } = (
      await server.app.inject({ method: 'POST', url: '/auth/token', headers: { cookie } })
    ).json()

    for (const token of [handoff, refreshToken]) {
      expect(() => verifyToken(token, server.key.publicKey, 'access', at)).toThrow(
        expect.objectContaining({ problem: 'signature' }),
      )
    }
  })

  it('signs the access token with the key CouchDB does have', async () => {
    // The positive control. Signing *everything* with the session key would pass the test
    // above and leave replication unable to authenticate at all.
    const server = signInServer()
    const { accessToken } = await tokensFor(server)

    expect(verifyToken(accessToken, server.key.publicKey, 'access', at).sub).toBe('google|1234')
  })
})

describe('POST /auth/signout', () => {
  it('revokes the refresh token and denies the access token', async () => {
    const server = signInServer()
    const tokens = await tokensFor(server)
    const out = await server.app.inject({
      method: 'POST',
      url: '/auth/signout',
      headers: { authorization: `Bearer ${tokens.accessToken}` },
      payload: { refreshToken: tokens.refreshToken },
    })
    expect(out.statusCode).toBe(204)
    const again = await server.app.inject({
      method: 'POST',
      url: '/auth/token',
      payload: { refreshToken: tokens.refreshToken },
    })
    expect(again.statusCode).toBe(401)
    const { jti } = verifyToken(tokens.accessToken, server.key.publicKey, 'access', at)
    expect(server.deny.denied(String(jti))).toBe(true)
  })

  it('revokes a refresh token whose hash is held on the record, not only in memory', async () => {
    // A record holds the hashes of somebody who has one, and memory is released into it. A
    // sign-out that cleared only memory would leave this thirty-day credential live.
    const server = signInServer()
    const tokens = await tokensFor(server)
    await recordEnsurer(
      server.records,
      server.refresh,
    )({
      email: 'ada@example.com',
      sub: 'google|1234',
    })
    expect((await server.records.read('ada@example.com'))?.refreshTokens).toHaveLength(1)

    const out = await server.app.inject({
      method: 'POST',
      url: '/auth/signout',
      payload: { refreshToken: tokens.refreshToken },
    })
    expect(out.statusCode).toBe(204)
    expect((await server.records.read('ada@example.com'))?.refreshTokens ?? []).toEqual([])

    const again = await server.app.inject({
      method: 'POST',
      url: '/auth/token',
      payload: { refreshToken: tokens.refreshToken },
    })
    expect(again.statusCode).toBe(401)
  })

  it('does not claim success when the refresh token could not be revoked', async () => {
    // The hash is still stored, so the refresh token is a live thirty-day credential. A 204
    // here would tell the one party who could retry that there is nothing left to do.
    const server = signInServer()
    const tokens = await tokensFor(server)
    await recordEnsurer(
      server.records,
      server.refresh,
    )({
      email: 'ada@example.com',
      sub: 'google|1234',
    })
    server.fails.putDoc = 'matter_manager'

    const out = await server.app.inject({
      method: 'POST',
      url: '/auth/signout',
      headers: { authorization: `Bearer ${tokens.accessToken}` },
      payload: { refreshToken: tokens.refreshToken },
    })

    expect(out.statusCode).not.toBe(204)
    expect(out.statusCode).toBe(500)
    expect(out.headers['content-type']).toMatch(/^application\/problem\+json/)
    expect(out.body).not.toContain('matter_manager')
    // What could be ended was: the access token is refused on this API regardless.
    const { jti } = verifyToken(tokens.accessToken, server.key.publicKey, 'access', at)
    expect(server.deny.denied(String(jti))).toBe(true)
    // And the refresh token is, honestly, still live.
    const again = await server.app.inject({
      method: 'POST',
      url: '/auth/token',
      payload: { refreshToken: tokens.refreshToken },
    })
    expect(again.statusCode).toBe(200)
  })

  it('answers 204 with nothing to sign out of', async () => {
    // Signing out when already signed out is not an error. Answering 401 would leave a user who
    // is confused about their state unable to reach a state they are certain about.
    const server = signInServer()
    expect((await server.app.inject({ method: 'POST', url: '/auth/signout' })).statusCode).toBe(204)
  })

  it('answers 204 for tokens that do not verify', async () => {
    const server = signInServer()
    const out = await server.app.inject({
      method: 'POST',
      url: '/auth/signout',
      headers: { authorization: 'Bearer not.a.token' },
      payload: { refreshToken: 'nor.is.this' },
    })
    expect(out.statusCode).toBe(204)
    expect(server.deny.size()).toBe(0)
  })

  it('clears the flow and handoff cookies', async () => {
    // A half-finished sign-in left behind at sign-out is a credential for a flow nobody is going
    // to complete.
    const { app: server } = signInServer()
    const response = await server.inject({ method: 'POST', url: '/auth/signout' })

    expect(cookieNamed(response.headers, 'mm_flow')).toContain('Max-Age=0')
    expect(cookieNamed(response.headers, 'mm_handoff')).toContain('Max-Age=0')
  })
})
