import { describe, expect, it, vi } from 'vitest'
import { requestTokens } from '../../src/ui/composition.js'
import { accessToken, forgetTokens } from '../../src/ui/tokens.js'

/** A refresh-token store held in a variable, so a test can see what was kept or cleared. */
const memoryStore = (initial?: string) => {
  let held = initial
  return {
    read: async () => held,
    write: async (t: string) => {
      held = t
    },
    clear: async () => {
      held = undefined
    },
    get held() {
      return held
    },
  }
}

const json = (status: number, body: unknown) =>
  vi.fn(
    async (_url: string, _init?: RequestInit) =>
      new Response(JSON.stringify(body), {
        status,
        headers: { 'content-type': 'application/json' },
      }),
  ) as unknown as typeof fetch & { mock: { calls: Array<[string, RequestInit]> } }

describe('requestTokens', () => {
  it('sends the stored refresh token in the body and keeps both tokens', async () => {
    forgetTokens()
    const store = memoryStore('r1')
    const fetchImpl = json(200, { accessToken: 'a', expiresIn: 300, refreshToken: 'r1' })
    expect(await requestTokens(store, fetchImpl)).toEqual({ kind: 'refreshed', expiresIn: 300 })
    const init = fetchImpl.mock.calls[0]?.[1] as RequestInit
    expect(JSON.parse(String(init.body))).toEqual({ refreshToken: 'r1' })
    expect(accessToken()).toBe('a')
  })

  it('sends the handoff cookie and an empty body when nothing is stored', async () => {
    const fetchImpl = json(200, { accessToken: 'a', expiresIn: 300, refreshToken: 'new' })
    await requestTokens(memoryStore(), fetchImpl)
    const init = fetchImpl.mock.calls[0]?.[1] as RequestInit
    expect(init.credentials).toBe('include')
    expect(JSON.parse(String(init.body))).toEqual({})
  })

  it('stores the refresh token from the first exchange after sign-in', async () => {
    const store = memoryStore()
    await requestTokens(store, json(200, { accessToken: 'a', expiresIn: 300, refreshToken: 'new' }))
    expect(store.held).toBe('new')
  })

  it('reports ended and forgets the token when a stored refresh token is refused', async () => {
    const store = memoryStore('r1')
    expect(await requestTokens(store, json(401, { title: 'Not signed in', status: 401 }))).toEqual({
      kind: 'ended',
    })
    expect(store.held).toBeUndefined()
  })

  it('reports signed-out on a 401 when there was no stored token', async () => {
    expect(await requestTokens(memoryStore(), json(401, {}))).toEqual({ kind: 'signed-out' })
  })

  it('reports unreachable, keeping the token, on a network error or a 5xx', async () => {
    const store = memoryStore('r1')
    const offline = vi.fn(async () => {
      throw new TypeError('offline')
    }) as unknown as typeof fetch
    expect(await requestTokens(store, offline)).toEqual({ kind: 'unreachable' })
    expect(await requestTokens(store, json(502, {}))).toEqual({ kind: 'unreachable' })
    expect(store.held).toBe('r1')
  })

  it.each([
    ['no refresh token', { accessToken: 'a', expiresIn: 300 }],
    ['an empty refresh token', { accessToken: 'a', expiresIn: 300, refreshToken: '' }],
    ['no access token', { expiresIn: 300, refreshToken: 'r' }],
    ['an expiry inside the margin', { accessToken: 'a', expiresIn: 30, refreshToken: 'r' }],
  ])('does not believe a 200 carrying %s', async (_name, body) => {
    forgetTokens()
    const store = memoryStore('r1')
    expect(await requestTokens(store, json(200, body))).toEqual({ kind: 'unreachable' })
    expect(accessToken()).toBeUndefined()
    expect(store.held).toBe('r1')
  })

  it('does not believe a 200 whose body is not JSON', async () => {
    const fetchImpl = vi.fn(
      async () => new Response('nope', { status: 200 }),
    ) as unknown as typeof fetch
    expect(await requestTokens(memoryStore('r1'), fetchImpl)).toEqual({ kind: 'unreachable' })
  })
})
