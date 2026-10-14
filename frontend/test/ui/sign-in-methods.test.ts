import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { CredentialsLike } from '../../src/ui/passkey-signin.js'
import { signInMethodsApi } from '../../src/ui/sign-in-methods.js'
import { forgetTokens, rememberAccessToken } from '../../src/ui/tokens.js'

const answer = (status: number, body?: unknown) =>
  Promise.resolve(
    new Response(body === undefined ? null : JSON.stringify(body), {
      status,
      headers: { 'content-type': 'application/json' },
    }),
  )

const PASSKEY = {
  id: 'pk-1',
  label: 'Laptop',
  createdAt: '2026-10-01T10:00:00Z',
  lastUsedAt: '2026-10-02T10:00:00Z',
}
const METHODS = { google: true, github: false, email: true, passkeys: [PASSKEY] }
const OPTIONS = {
  challenge: 'AQID',
  rp: { name: 'Matter Manager', id: 'example.com' },
  user: { id: 'BAUG', name: 'a@b.c', displayName: 'A' },
  pubKeyCredParams: [{ type: 'public-key', alg: -7 }],
  excludeCredentials: [],
}

/** A hand-built attestation: the bytes are arbitrary, only the shape matters. */
const credential = {
  id: 'cred-1',
  type: 'public-key',
  rawId: new Uint8Array([1, 2, 3]).buffer,
  response: {
    clientDataJSON: new Uint8Array([4]).buffer,
    attestationObject: new Uint8Array([5]).buffer,
  },
} as unknown as PublicKeyCredential

function fakeCredentials(create: () => Promise<Credential | null>) {
  const spy = vi.fn(create)
  const credentials: CredentialsLike = {
    get: async () => {
      throw new Error('get is not part of registration')
    },
    create: spy,
  }
  return { credentials, create: spy }
}

/** Fake fetch routed by `METHOD path`, recording every call. */
function fakeFetch(routes: Record<string, () => Promise<Response>>) {
  const calls: { url: string; init: RequestInit }[] = []
  const impl = ((url: string, init: RequestInit = {}) => {
    calls.push({ url, init })
    const route = routes[`${init.method ?? 'GET'} ${url}`]
    return route === undefined ? Promise.reject(new Error('no route')) : route()
  }) as unknown as typeof fetch
  return { impl, calls }
}

const bearerOf = (init: RequestInit) => (init.headers as Record<string, string>).authorization

beforeEach(() => rememberAccessToken({ accessToken: 'tok', expiresIn: 3600 }))
afterEach(() => forgetTokens())

describe('read', () => {
  it('answers the methods, with the bearer', async () => {
    const f = fakeFetch({ 'GET /api/auth/sign-in-methods': () => answer(200, METHODS) })
    expect(await signInMethodsApi('/api', f.impl).read()).toEqual({
      kind: 'methods',
      methods: METHODS,
    })
    expect(bearerOf(f.calls[0]?.init as RequestInit)).toBe('Bearer tok')
  })

  it('is signed-out without a request when no token is held', async () => {
    forgetTokens()
    const f = fakeFetch({})
    expect(await signInMethodsApi('/api', f.impl).read()).toEqual({ kind: 'signed-out' })
    expect(f.calls).toHaveLength(0)
  })

  it('maps 401 to signed-out', async () => {
    const f = fakeFetch({ 'GET /api/auth/sign-in-methods': () => answer(401) })
    expect(await signInMethodsApi('/api', f.impl).read()).toEqual({ kind: 'signed-out' })
  })

  it.each([
    ['a body without passkeys', () => answer(200, { google: true, github: true, email: true })],
    ['a body that is not JSON', () => Promise.resolve(new Response('<html>', { status: 200 }))],
    ['a 500', () => answer(500)],
    ['a network failure', () => Promise.reject(new Error('offline'))],
  ])('is unreachable on %s', async (_name, route) => {
    const f = fakeFetch({ 'GET /api/auth/sign-in-methods': route })
    expect(await signInMethodsApi('/api', f.impl).read()).toEqual({ kind: 'unreachable' })
  })
})

describe('add', () => {
  const routes = (post: () => Promise<Response>) => ({
    'POST /api/auth/passkeys/options': () => answer(200, OPTIONS),
    'POST /api/auth/passkeys': post,
  })

  it('runs options, create, then registers, each with the bearer', async () => {
    const f = fakeFetch(routes(() => answer(201, PASSKEY)))
    const c = fakeCredentials(async () => credential)
    expect(await signInMethodsApi('/api', f.impl).add(c.credentials)).toEqual({
      kind: 'added',
      passkey: PASSKEY,
    })
    expect(f.calls.map((call) => call.url)).toEqual([
      '/api/auth/passkeys/options',
      '/api/auth/passkeys',
    ])
    for (const call of f.calls) expect(bearerOf(call.init)).toBe('Bearer tok')
    expect(JSON.parse(f.calls[1]?.init.body as string).id).toBe('cred-1')
  })

  it('is signed-out without a request when no token is held', async () => {
    forgetTokens()
    const f = fakeFetch({})
    const c = fakeCredentials(async () => credential)
    expect(await signInMethodsApi('/api', f.impl).add(c.credentials)).toEqual({
      kind: 'signed-out',
    })
    expect(f.calls).toHaveLength(0)
    expect(c.create).not.toHaveBeenCalled()
  })

  it('maps 401 from the options call to signed-out', async () => {
    const f = fakeFetch({ 'POST /api/auth/passkeys/options': () => answer(401) })
    const c = fakeCredentials(async () => credential)
    expect(await signInMethodsApi('/api', f.impl).add(c.credentials)).toEqual({
      kind: 'signed-out',
    })
    expect(c.create).not.toHaveBeenCalled()
  })

  it('maps 409 to full', async () => {
    const f = fakeFetch(routes(() => answer(409)))
    const c = fakeCredentials(async () => credential)
    expect(await signInMethodsApi('/api', f.impl).add(c.credentials)).toEqual({ kind: 'full' })
  })

  it('maps 401 from the registration to signed-out', async () => {
    const f = fakeFetch(routes(() => answer(401)))
    const c = fakeCredentials(async () => credential)
    expect(await signInMethodsApi('/api', f.impl).add(c.credentials)).toEqual({
      kind: 'signed-out',
    })
  })

  it('is dismissed, with no registration, when the person closes the sheet', async () => {
    const f = fakeFetch(routes(() => answer(201, PASSKEY)))
    const c = fakeCredentials(async () => {
      throw new DOMException('closed', 'NotAllowedError')
    })
    expect(await signInMethodsApi('/api', f.impl).add(c.credentials)).toEqual({ kind: 'dismissed' })
    expect(f.calls).toHaveLength(1)
  })

  it.each([
    ['a null credential', async () => null],
    [
      'another rejection',
      async () => {
        throw new DOMException('x', 'InvalidStateError')
      },
    ],
  ])('is unreachable on %s, with no registration', async (_name, create) => {
    const f = fakeFetch(routes(() => answer(201, PASSKEY)))
    const c = fakeCredentials(create)
    expect(await signInMethodsApi('/api', f.impl).add(c.credentials)).toEqual({
      kind: 'unreachable',
    })
    expect(f.calls).toHaveLength(1)
  })

  it('is unreachable on unusable options, without opening the sheet', async () => {
    const f = fakeFetch({ 'POST /api/auth/passkeys/options': () => answer(200, { nope: 1 }) })
    const c = fakeCredentials(async () => credential)
    expect(await signInMethodsApi('/api', f.impl).add(c.credentials)).toEqual({
      kind: 'unreachable',
    })
    expect(c.create).not.toHaveBeenCalled()
  })

  it.each([
    ['a 500', () => answer(500)],
    ['a 201 that is not a passkey', () => answer(201, { id: 1 })],
    ['a network failure', () => Promise.reject(new Error('offline'))],
  ])('is unreachable when registration answers %s', async (_name, post) => {
    const f = fakeFetch(routes(post))
    const c = fakeCredentials(async () => credential)
    expect(await signInMethodsApi('/api', f.impl).add(c.credentials)).toEqual({
      kind: 'unreachable',
    })
  })
})

describe('rename and remove', () => {
  it('rename PATCHes the label with the bearer', async () => {
    const f = fakeFetch({ 'PATCH /api/auth/passkeys/pk%2F1': () => answer(200, PASSKEY) })
    expect(await signInMethodsApi('/api', f.impl).rename('pk/1', 'Phone')).toEqual({ kind: 'done' })
    expect(bearerOf(f.calls[0]?.init as RequestInit)).toBe('Bearer tok')
    expect(JSON.parse(f.calls[0]?.init.body as string)).toEqual({ label: 'Phone' })
  })

  it('remove DELETEs with the bearer', async () => {
    const f = fakeFetch({ 'DELETE /api/auth/passkeys/pk-1': () => answer(204) })
    expect(await signInMethodsApi('/api', f.impl).remove('pk-1')).toEqual({ kind: 'done' })
    expect(bearerOf(f.calls[0]?.init as RequestInit)).toBe('Bearer tok')
  })

  it.each([
    [200, { kind: 'done' }],
    [204, { kind: 'done' }],
    [404, { kind: 'missing' }],
    [401, { kind: 'signed-out' }],
    [500, { kind: 'unreachable' }],
  ])('maps status %i', async (status, expected) => {
    const f = fakeFetch({
      'PATCH /api/auth/passkeys/pk-1': () => answer(status),
      'DELETE /api/auth/passkeys/pk-1': () => answer(status),
    })
    const api = signInMethodsApi('/api', f.impl)
    expect(await api.rename('pk-1', 'x')).toEqual(expected)
    expect(await api.remove('pk-1')).toEqual(expected)
  })

  it('is signed-out without a request when no token is held', async () => {
    forgetTokens()
    const f = fakeFetch({})
    const api = signInMethodsApi('/api', f.impl)
    expect(await api.rename('pk-1', 'x')).toEqual({ kind: 'signed-out' })
    expect(await api.remove('pk-1')).toEqual({ kind: 'signed-out' })
    expect(f.calls).toHaveLength(0)
  })

  it('is unreachable on a network failure', async () => {
    const f = fakeFetch({})
    const api = signInMethodsApi('/api', f.impl)
    expect(await api.rename('pk-1', 'x')).toEqual({ kind: 'unreachable' })
    expect(await api.remove('pk-1')).toEqual({ kind: 'unreachable' })
  })
})
