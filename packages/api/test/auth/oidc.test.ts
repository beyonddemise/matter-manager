import { createSign, generateKeyPairSync } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { googleProvider, jwksCache, verifyGoogleIdToken } from '../../src/auth/google.js'
import { signingKeyFromPem } from '../../src/auth/jwt.js'
import {
  beginSignIn,
  codeChallenge,
  completeSignIn,
  type FlowState,
  identityFrom,
  type Provider,
  readFlowState,
  SignInError,
} from '../../src/auth/oidc.js'

function newKey(kid = 'ec-test') {
  const { privateKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' })
  return signingKeyFromPem(kid, privateKey.export({ type: 'pkcs8', format: 'pem' }).toString())
}

const PROVIDER: Provider = googleProvider({
  clientId: 'client-123.apps.googleusercontent.com',
  clientSecret: 'secret',
  redirectUri: 'https://matter.example/auth/google/callback',
})

describe('starting a sign-in', () => {
  it('sends the browser to the provider with everything PKCE needs', () => {
    const { authorizeUrl } = beginSignIn(PROVIDER, newKey())
    const url = new URL(authorizeUrl)

    expect(url.origin + url.pathname).toBe(PROVIDER.authorizationEndpoint)
    expect(url.searchParams.get('response_type')).toBe('code')
    expect(url.searchParams.get('client_id')).toBe(PROVIDER.clientId)
    expect(url.searchParams.get('redirect_uri')).toBe(PROVIDER.redirectUri)
    expect(url.searchParams.get('code_challenge_method')).toBe('S256')
    expect(url.searchParams.get('code_challenge')).toBeTruthy()
    expect(url.searchParams.get('state')).toBeTruthy()
  })

  it('never puts the verifier in the URL', () => {
    // The whole point of PKCE. The authorization request goes through the user's browser, into
    // logs and referrers and extensions; the verifier stays here.
    const { authorizeUrl, carrier } = beginSignIn(PROVIDER, newKey())
    const flow = JSON.parse(
      Buffer.from(carrier.split('.')[1] ?? '', 'base64url').toString(),
    ) as FlowState

    expect(authorizeUrl).not.toContain(flow.verifier)
    expect(new URL(authorizeUrl).searchParams.get('code_challenge')).toBe(
      codeChallenge(flow.verifier),
    )
  })

  it('uses S256 rather than plain', () => {
    // `plain` sends the verifier itself as the challenge, which is the thing PKCE exists to keep
    // off the wire. It is in the specification for clients that cannot compute a SHA-256, and a
    // Node service is not one.
    const verifier = 'a-known-verifier'
    expect(codeChallenge(verifier)).not.toBe(verifier)
    expect(codeChallenge(verifier)).toHaveLength(43)
  })

  it('asks for nothing beyond what it needs', () => {
    // Every extra scope is a consent screen asking for more than the application uses, on the
    // first screen a new user ever sees.
    expect(PROVIDER.scopes).toEqual(['openid', 'email', 'profile'])
  })

  it('gives every sign-in its own state and verifier', () => {
    const one = beginSignIn(PROVIDER, newKey())
    const two = beginSignIn(PROVIDER, newKey())

    expect(new URL(one.authorizeUrl).searchParams.get('state')).not.toBe(
      new URL(two.authorizeUrl).searchParams.get('state'),
    )
  })

  it.each([
    ['an absolute URL', 'https://evil.example/steal'],
    ['a protocol-relative URL', '//evil.example/steal'],
    ['something that is not a path', 'javascript:alert(1)'],
  ])('refuses to carry %s as a return address', (_case, returnTo) => {
    // An open redirect here is a phishing primitive wearing this application's own domain:
    // sign in legitimately, be sent somewhere else.
    const { carrier } = beginSignIn(PROVIDER, newKey(), returnTo)
    const flow = JSON.parse(
      Buffer.from(carrier.split('.')[1] ?? '', 'base64url').toString(),
    ) as FlowState

    expect(flow.returnTo).toBe('/')
  })

  it('carries a path the application asked for', () => {
    const { carrier } = beginSignIn(PROVIDER, newKey(), '/devices/abc')
    const flow = JSON.parse(
      Buffer.from(carrier.split('.')[1] ?? '', 'base64url').toString(),
    ) as FlowState

    expect(flow.returnTo).toBe('/devices/abc')
  })
})

describe('checking the callback', () => {
  it('accepts the state it issued', () => {
    const key = newKey()
    const { authorizeUrl, carrier } = beginSignIn(PROVIDER, key)
    const state = new URL(authorizeUrl).searchParams.get('state') ?? ''

    expect(readFlowState(carrier, state, key).state).toBe(state)
  })

  it('refuses a state that does not match', () => {
    // CSRF. Without this an attacker walks a victim's browser through *their* sign-in, and the
    // victim ends up signed in as the attacker — in an application holding their home's
    // commissioning codes.
    const key = newKey()
    const { carrier } = beginSignIn(PROVIDER, key)

    expect(() => readFlowState(carrier, 'not-the-state', key)).toThrow(
      expect.objectContaining({ problem: 'state' }),
    )
  })

  it('refuses a carrier signed by somebody else', () => {
    const { authorizeUrl, carrier } = beginSignIn(PROVIDER, newKey())
    const state = new URL(authorizeUrl).searchParams.get('state') ?? ''

    expect(() => readFlowState(carrier, state, newKey())).toThrow(SignInError)
  })

  it('refuses an expired carrier', () => {
    const key = newKey()
    const at = 1_700_000_000
    const { authorizeUrl, carrier } = beginSignIn(PROVIDER, key, '/', () => at)
    const state = new URL(authorizeUrl).searchParams.get('state') ?? ''

    expect(() => readFlowState(carrier, state, key, () => at + 3600)).toThrow(
      expect.objectContaining({ problem: 'state' }),
    )
  })

  it.each([
    ['no carrier', undefined, 'some-state'],
    ['no returned state', 'carrier', undefined],
    ['neither', undefined, undefined],
  ])('refuses a callback with %s', (_case, carrier, state) => {
    expect(() => readFlowState(carrier, state, newKey())).toThrow(
      expect.objectContaining({ problem: 'state' }),
    )
  })

  it('refuses a valid carrier with no state beside it', () => {
    // Isolated deliberately. The other "missing" cases pair a missing state with a carrier that
    // is invalid anyway, so they are refused for the wrong reason and would pass without this
    // check at all. With a *valid* carrier and no state, dropping the guard means comparing
    // against `undefined` — which throws a TypeError out of the route as a 500, rather than
    // returning the user to the application to try again.
    const key = newKey()
    const { carrier } = beginSignIn(PROVIDER, key)

    expect(() => readFlowState(carrier, undefined, key)).toThrow(
      expect.objectContaining({ problem: 'state' }),
    )
  })

  it('says the same thing however it failed', () => {
    // Four different causes, one answer: start again. Distinguishing them in the response tells
    // an attacker which part of their attempt was wrong.
    const key = newKey()
    const { carrier } = beginSignIn(PROVIDER, key)
    const problems = [
      () => readFlowState(undefined, 'x', key),
      () => readFlowState(carrier, 'wrong', key),
      () => readFlowState('not.a.token', 'x', key),
    ].map((run) => {
      try {
        run()
        return 'no error'
      } catch (error) {
        return (error as SignInError).problem
      }
    })

    expect(problems).toEqual(['state', 'state', 'state'])
  })
})

describe('exchanging the code', () => {
  const flow: FlowState = {
    state: 's',
    verifier: 'the-verifier',
    returnTo: '/',
    exp: Math.floor(Date.now() / 1000) + 600,
  }

  function fakeExchange(status: number, body: unknown) {
    const calls: Array<{ url: string; body: string }> = []
    const impl = (async (url: string | URL, init?: RequestInit) => {
      calls.push({ url: String(url), body: String(init?.body ?? '') })
      return {
        ok: status < 400,
        status,
        json: async () => body,
      } as Response
    }) as unknown as typeof fetch
    return { impl, calls }
  }

  const identity = async () => ({ sub: 'google|1234', email: 'a@b.c' })

  it('sends the verifier and the secret, server to server', async () => {
    // Neither ever passes through the browser. The verifier is what makes an intercepted code
    // useless; the secret is what makes the client this client.
    const { impl, calls } = fakeExchange(200, { id_token: 'header.payload.sig' })
    await completeSignIn(PROVIDER, 'the-code', flow, identity, impl)

    const sent = new URLSearchParams(calls[0]?.body ?? '')
    expect(calls[0]?.url).toBe(PROVIDER.tokenEndpoint)
    expect(sent.get('code_verifier')).toBe('the-verifier')
    expect(sent.get('client_secret')).toBe('secret')
    expect(sent.get('grant_type')).toBe('authorization_code')
    expect(sent.get('redirect_uri')).toBe(PROVIDER.redirectUri)
  })

  it('returns the identity the ID token carried', async () => {
    const { impl } = fakeExchange(200, { id_token: 'x.y.z' })

    expect((await completeSignIn(PROVIDER, 'c', flow, identity, impl)).sub).toBe('google|1234')
  })

  it('reports a refused exchange with the provider’s own code', async () => {
    // `invalid_grant` and `access_denied` are short, safe and actionable. The body is neither
    // logged nor echoed: it carries tokens.
    const { impl } = fakeExchange(400, { error: 'invalid_grant' })

    await expect(completeSignIn(PROVIDER, 'c', flow, identity, impl)).rejects.toThrow(
      /invalid_grant/,
    )
  })

  it('refuses an answer with no ID token in it', async () => {
    const { impl } = fakeExchange(200, { access_token: 'only-this' })

    await expect(completeSignIn(PROVIDER, 'c', flow, identity, impl)).rejects.toThrow(
      expect.objectContaining({ problem: 'exchange' }),
    )
  })

  it('refuses an answer that is not JSON', async () => {
    const impl = (async () =>
      ({
        ok: true,
        status: 200,
        json: async () => {
          throw new SyntaxError('nope')
        },
      }) as unknown as Response) as unknown as typeof fetch

    await expect(completeSignIn(PROVIDER, 'c', flow, identity, impl)).rejects.toThrow(SignInError)
  })
})

describe('reading an identity', () => {
  it('namespaces the subject by provider', () => {
    // So two providers cannot collide on a numeric subject, and so a CouchDB user name says
    // where the identity came from.
    expect(identityFrom(PROVIDER, { sub: '1234' }).sub).toBe('google|1234')
  })

  it('keeps the fields worth showing beside a remark', () => {
    expect(identityFrom(PROVIDER, { sub: '1', email: 'a@b.c', name: 'Ada' })).toEqual({
      sub: 'google|1',
      email: 'a@b.c',
      name: 'Ada',
    })
  })

  it('leaves out a field the provider did not give', () => {
    // Absent rather than empty: an empty name reads back as a person called nothing.
    expect(identityFrom(PROVIDER, { sub: '1', name: '' })).toEqual({ sub: 'google|1' })
  })

  it.each([
    ['nothing', {}],
    ['a numeric subject', { sub: 1234 }],
    ['an empty subject', { sub: '' }],
  ])('refuses an identity with %s', (_case, claims) => {
    expect(() => identityFrom(PROVIDER, claims)).toThrow(
      expect.objectContaining({ problem: 'identity' }),
    )
  })
})

describe('verifying a Google ID token', () => {
  /** A real RSA key, so the signature path is exercised rather than described. */
  const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 })
  const jwk = publicKey.export({ format: 'jwk' })
  const KID = 'google-key-1'

  function idToken(claims: Record<string, unknown>, alg = 'RS256', kid = KID): string {
    const header = Buffer.from(JSON.stringify({ alg, kid, typ: 'JWT' })).toString('base64url')
    const payload = Buffer.from(JSON.stringify(claims)).toString('base64url')
    const signer = createSign('RSA-SHA256')
    signer.update(`${header}.${payload}`)
    return `${header}.${payload}.${signer.sign(privateKey).toString('base64url')}`
  }

  const good = () => ({
    sub: '1234',
    iss: 'https://accounts.google.com',
    aud: PROVIDER.clientId,
    exp: Math.floor(Date.now() / 1000) + 600,
    email: 'ada@example.com',
    name: 'Ada',
  })

  function keysFor(keys: unknown[] = [{ ...jwk, kid: KID }]) {
    let fetches = 0
    const impl = (async () => {
      fetches += 1
      return { ok: true, status: 200, json: async () => ({ keys }) } as Response
    }) as unknown as typeof fetch
    return { cache: jwksCache(PROVIDER.jwksUri, impl), fetches: () => fetches }
  }

  it('accepts a properly signed token', async () => {
    const { cache } = keysFor()

    expect((await verifyGoogleIdToken(PROVIDER, idToken(good()), cache)).sub).toBe('google|1234')
  })

  it('refuses one signed with another key', async () => {
    const other = generateKeyPairSync('rsa', { modulusLength: 2048 })
    const { cache } = keysFor([{ ...other.publicKey.export({ format: 'jwk' }), kid: KID }])

    await expect(verifyGoogleIdToken(PROVIDER, idToken(good()), cache)).rejects.toThrow(/signature/)
  })

  it('refuses one issued to a different application', async () => {
    // The confused-deputy check. A validly-signed Google token issued to another application is
    // an ordinary thing that exists; without this, anybody holding a Google client id could sign
    // their users into this one.
    const { cache } = keysFor()

    await expect(
      verifyGoogleIdToken(PROVIDER, idToken({ ...good(), aud: 'someone-else' }), cache),
    ).rejects.toThrow(/different application/)
  })

  it('accepts a token whose aud is a list containing us', async () => {
    const { cache } = keysFor()

    expect(
      (
        await verifyGoogleIdToken(
          PROVIDER,
          idToken({ ...good(), aud: ['x', PROVIDER.clientId] }),
          cache,
        )
      ).sub,
    ).toBe('google|1234')
  })

  it('refuses one from another issuer', async () => {
    const { cache } = keysFor()

    await expect(
      verifyGoogleIdToken(PROVIDER, idToken({ ...good(), iss: 'https://evil.example' }), cache),
    ).rejects.toThrow(/not issued by Google/)
  })

  it('refuses an expired one', async () => {
    const { cache } = keysFor()

    await expect(
      verifyGoogleIdToken(PROVIDER, idToken({ ...good(), exp: 1000 }), cache),
    ).rejects.toThrow(/expired/)
  })

  it.each([['none'], ['HS256'], ['ES256']])('refuses one claiming %s', async (alg) => {
    // Checked before the signature, as everywhere else in this service.
    const { cache } = keysFor()

    await expect(verifyGoogleIdToken(PROVIDER, idToken(good(), alg), cache)).rejects.toThrow(
      /RS256/,
    )
  })

  it('refuses one naming a key Google does not publish', async () => {
    const { cache } = keysFor()

    await expect(
      verifyGoogleIdToken(PROVIDER, idToken(good(), 'RS256', 'not-a-real-kid'), cache),
    ).rejects.toThrow(/does not publish/)
  })
})

describe('the JWKS cache', () => {
  const { publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 })
  const jwk = { ...publicKey.export({ format: 'jwk' }), kid: 'k1' }

  function counting(keys: unknown[]) {
    let fetches = 0
    const impl = (async () => {
      fetches += 1
      return { ok: true, status: 200, json: async () => ({ keys }) } as Response
    }) as unknown as typeof fetch
    return { impl, fetches: () => fetches }
  }

  it('fetches once and remembers', async () => {
    // A sign-in is not the moment to fetch a key set. Google rotates on the order of days.
    const { impl, fetches } = counting([jwk])
    const cache = jwksCache('https://keys.test', impl)

    await cache.get('k1')
    await cache.get('k1')

    expect(fetches()).toBe(1)
  })

  it('refetches once when a key is missing, which is what makes rotation survivable', async () => {
    // A token arrives signed with a key added since the cache was filled. Without the refetch,
    // every rotation produces a window of failed sign-ins ending whenever the cache expires.
    const { impl, fetches } = counting([jwk])
    const cache = jwksCache('https://keys.test', impl)

    await cache.get('k1')
    expect(await cache.get('k-new')).toBeUndefined()
    expect(fetches()).toBe(2)
  })

  it('skips a key it cannot import rather than failing the whole set', async () => {
    // An unusual curve or a future algorithm. Refusing the set would turn one unfamiliar key
    // into a total sign-in outage.
    const { impl } = counting([{ kty: 'OKP', crv: 'Ed99', x: 'nope', kid: 'weird' }, jwk])
    const cache = jwksCache('https://keys.test', impl)

    expect(await cache.get('k1')).toBeDefined()
  })

  it('reports a key set it could not read', async () => {
    const impl = (async () => ({ ok: false, status: 503 }) as Response) as unknown as typeof fetch

    await expect(jwksCache('https://keys.test', impl).get('k1')).rejects.toThrow(SignInError)
  })
})
