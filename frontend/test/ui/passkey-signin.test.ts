import { describe, expect, it, vi } from 'vitest'
import { type CredentialsLike, passkeySignIn } from '../../src/ui/passkey-signin.js'
import { accessToken, forgetTokens } from '../../src/ui/tokens.js'

const answer = (status: number, body?: unknown) =>
  Promise.resolve(
    new Response(body === undefined ? null : JSON.stringify(body), {
      status,
      headers: { 'content-type': 'application/json' },
    }),
  )

function memoryStore() {
  let token: string | undefined
  return {
    written: () => token,
    read: async () => token,
    write: async (t: string) => {
      token = t
    },
    clear: async () => {
      token = undefined
    },
  }
}

const OPTIONS = { challenge: 'AQID', rpId: 'example.com', allowCredentials: [] }
const TOKENS = { accessToken: 'acc', expiresIn: 300, refreshToken: 'ref' }

/** A hand-built assertion: the bytes are arbitrary, only the shape matters. */
const credential = {
  id: 'cred-1',
  type: 'public-key',
  rawId: new Uint8Array([1, 2, 3]).buffer,
  response: {
    clientDataJSON: new Uint8Array([4]).buffer,
    authenticatorData: new Uint8Array([5]).buffer,
    signature: new Uint8Array([6]).buffer,
    userHandle: null,
  },
} as unknown as PublicKeyCredential

/** Fake credentials whose `get` is a spy; `create` is never part of sign-in. */
function fakeCredentials(get: () => Promise<Credential | null>) {
  const spy = vi.fn(get)
  const credentials: CredentialsLike = {
    get: spy,
    create: async () => {
      throw new Error('create is not part of sign-in')
    },
  }
  return { credentials, get: spy }
}

/** Fake fetch routed by path, recording every call. */
function fakeFetch(routes: Record<string, () => Promise<Response>>) {
  const calls: { url: string; init?: RequestInit }[] = []
  const impl = ((url: string, init?: RequestInit) => {
    calls.push({ url, ...(init === undefined ? {} : { init }) })
    const route = routes[url]
    if (route === undefined) throw new Error(`unexpected ${url}`)
    return route()
  }) as unknown as typeof fetch
  return { impl, calls }
}

describe('passkeySignIn', () => {
  it('runs the ceremony and adopts the token pair', async () => {
    forgetTokens()
    const store = memoryStore()
    const { credentials, get } = fakeCredentials(async () => credential)
    const { impl, calls } = fakeFetch({
      'https://api/auth/passkey/options': () => answer(200, OPTIONS),
      'https://api/auth/passkey': () => answer(200, TOKENS),
    })

    expect(await passkeySignIn('https://api', store, credentials, impl).signIn()).toEqual({
      kind: 'signed-in',
      expiresIn: 300,
    })
    expect(get).toHaveBeenCalledTimes(1)
    expect(accessToken()).toBe('acc')
    expect(store.written()).toBe('ref')
    // The options request carries an empty object and only a content type.
    expect(calls[0]?.init?.body).toBe('{}')
    expect(calls[0]?.init?.headers).toEqual({ 'content-type': 'application/json' })
    // The completion body is the assertion in JSON form.
    expect(JSON.parse(calls[1]?.init?.body as string)).toMatchObject({
      id: 'cred-1',
      rawId: 'AQID',
    })
    forgetTokens()
  })

  it('a 401 on completion is failed and keeps no tokens', async () => {
    forgetTokens()
    const store = memoryStore()
    const { credentials } = fakeCredentials(async () => credential)
    const { impl } = fakeFetch({
      'https://api/auth/passkey/options': () => answer(200, OPTIONS),
      'https://api/auth/passkey': () => answer(401, { title: 'Sign-in failed' }),
    })

    expect((await passkeySignIn('https://api', store, credentials, impl).signIn()).kind).toBe(
      'failed',
    )
    expect(accessToken()).toBeUndefined()
    expect(store.written()).toBeUndefined()
  })

  it('a 404 on options is unavailable and never opens the OS sheet', async () => {
    const { credentials, get } = fakeCredentials(async () => credential)
    const { impl } = fakeFetch({ 'https://api/auth/passkey/options': () => answer(404, {}) })

    expect(
      (await passkeySignIn('https://api', memoryStore(), credentials, impl).signIn()).kind,
    ).toBe('unavailable')
    expect(get).not.toHaveBeenCalled()
  })

  it('an options body that is not WebAuthn JSON is unreachable, with no ceremony', async () => {
    const { credentials, get } = fakeCredentials(async () => credential)
    const { impl, calls } = fakeFetch({
      'https://api/auth/passkey/options': () =>
        Promise.resolve(new Response('<html>proxy</html>', { status: 200 })),
    })

    expect(
      (await passkeySignIn('https://api', memoryStore(), credentials, impl).signIn()).kind,
    ).toBe('unreachable')
    expect(get).not.toHaveBeenCalled()
    expect(calls).toHaveLength(1)
  })

  it('a closed sheet is dismissed, and nothing is posted', async () => {
    const { credentials } = fakeCredentials(() =>
      Promise.reject(new DOMException('closed', 'NotAllowedError')),
    )
    const { impl, calls } = fakeFetch({
      'https://api/auth/passkey/options': () => answer(200, OPTIONS),
    })

    expect(
      (await passkeySignIn('https://api', memoryStore(), credentials, impl).signIn()).kind,
    ).toBe('dismissed')
    expect(calls).toHaveLength(1)
  })

  it('any other rejection from get() is unreachable', async () => {
    const { credentials } = fakeCredentials(() => Promise.reject(new Error('boom')))
    const { impl, calls } = fakeFetch({
      'https://api/auth/passkey/options': () => answer(200, OPTIONS),
    })

    expect(
      (await passkeySignIn('https://api', memoryStore(), credentials, impl).signIn()).kind,
    ).toBe('unreachable')
    expect(calls).toHaveLength(1)
  })

  it('a refresh token the device cannot store is unreachable, and keeps no access token', async () => {
    // Half a sign-in is worse than none, exactly as for the email flow.
    forgetTokens()
    const store = memoryStore()
    store.write = async () => {
      throw new Error('storage refused')
    }
    const { credentials } = fakeCredentials(async () => credential)
    const { impl } = fakeFetch({
      'https://api/auth/passkey/options': () => answer(200, OPTIONS),
      'https://api/auth/passkey': () => answer(200, TOKENS),
    })

    expect((await passkeySignIn('https://api', store, credentials, impl).signIn()).kind).toBe(
      'unreachable',
    )
    expect(accessToken()).toBeUndefined()
  })

  it('a null credential, a thrown fetch and a lying 200 are unreachable', async () => {
    const empty = fakeCredentials(async () => null)
    const ok = fakeFetch({ 'https://api/auth/passkey/options': () => answer(200, OPTIONS) })
    expect(
      (await passkeySignIn('https://api', memoryStore(), empty.credentials, ok.impl).signIn()).kind,
    ).toBe('unreachable')

    const down = fakeCredentials(async () => credential)
    const failing = (() => Promise.reject(new Error('x'))) as unknown as typeof fetch
    expect(
      (await passkeySignIn('https://api', memoryStore(), down.credentials, failing).signIn()).kind,
    ).toBe('unreachable')
    expect(down.get).not.toHaveBeenCalled()

    const store = memoryStore()
    const lying = fakeFetch({
      'https://api/auth/passkey/options': () => answer(200, OPTIONS),
      'https://api/auth/passkey': () => answer(200, { accessToken: '' }),
    })
    expect(
      (
        await passkeySignIn(
          'https://api',
          store,
          fakeCredentials(async () => credential).credentials,
          lying.impl,
        ).signIn()
      ).kind,
    ).toBe('unreachable')
    expect(store.written()).toBeUndefined()
  })
})
