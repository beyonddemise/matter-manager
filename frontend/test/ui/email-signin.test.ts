import { describe, expect, it } from 'vitest'
import { emailSignIn } from '../../src/ui/email-signin.js'
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

describe('startEmailSignIn', () => {
  it('answers the challenge and sends address and locale', async () => {
    let sent: RequestInit | undefined
    const client = emailSignIn('https://api', memoryStore(), ((url: string, init?: RequestInit) => {
      expect(url).toBe('https://api/auth/email')
      sent = init
      return answer(202, { challenge: 'c-1' })
    }) as unknown as typeof fetch)
    expect(await client.start('ada@example.com', 'de')).toEqual({
      kind: 'challenge',
      challenge: 'c-1',
    })
    expect(JSON.parse(sent?.body as string)).toEqual({ email: 'ada@example.com', locale: 'de' })
  })

  it.each([
    [400, 'refused'],
    [404, 'unavailable'],
    [429, 'throttled'],
    [500, 'unreachable'],
  ])('maps %s to %s', async (status, kind) => {
    const client = emailSignIn('https://api', memoryStore(), (() =>
      answer(status, {})) as unknown as typeof fetch)
    expect((await client.start('a@b.co', 'en')).kind).toBe(kind)
  })

  it('a thrown fetch is unreachable, and a 202 without a challenge too', async () => {
    const down = emailSignIn('https://api', memoryStore(), (() =>
      Promise.reject(new Error('x'))) as unknown as typeof fetch)
    expect((await down.start('a@b.co', 'en')).kind).toBe('unreachable')
    const odd = emailSignIn('https://api', memoryStore(), (() =>
      answer(202, {})) as unknown as typeof fetch)
    expect((await odd.start('a@b.co', 'en')).kind).toBe('unreachable')
  })
})

describe('completeEmailSignIn', () => {
  it('on 200 remembers the access token, stores the refresh token, reports signed-in', async () => {
    forgetTokens()
    const store = memoryStore()
    const client = emailSignIn('https://api', store, ((url: string) => {
      expect(url).toBe('https://api/auth/email/c-1')
      return answer(200, { accessToken: 'acc', expiresIn: 300, refreshToken: 'ref' })
    }) as unknown as typeof fetch)
    expect(await client.complete('c-1', '123456')).toEqual({ kind: 'signed-in', expiresIn: 300 })
    expect(accessToken()).toBe('acc')
    expect(store.written()).toBe('ref')
    forgetTokens()
  })

  it('a 401 is failed and stores nothing; a token-shaped lie is unreachable', async () => {
    forgetTokens()
    const store = memoryStore()
    const refused = emailSignIn('https://api', store, (() =>
      answer(401, { title: 'Sign-in failed' })) as unknown as typeof fetch)
    expect((await refused.complete('c-1', '000000')).kind).toBe('failed')
    expect(accessToken()).toBeUndefined()
    expect(store.written()).toBeUndefined()
    const lying = emailSignIn('https://api', store, (() =>
      answer(200, { accessToken: '' })) as unknown as typeof fetch)
    expect((await lying.complete('c-1', '123456')).kind).toBe('unreachable')
    expect(store.written()).toBeUndefined()
  })
})
