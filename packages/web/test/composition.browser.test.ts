import { beforeEach, describe, expect, it, vi } from 'vitest'
import { API_BASE, beginSignIn, COUCH_BASE, readSessionState } from '../src/composition.js'
import { accessToken, forgetTokens } from '../src/tokens.js'

/**
 * #120: seven modules were written, tested, and imported by nothing but their own tests. Every
 * one was correct; what was missing was the file that constructs them.
 *
 * These tests are about that file, so they exercise it rather than the modules underneath —
 * those have their own suites, and repeating them here would only mean two places to update.
 * What is checked is the wiring: the right path, the credentials that make the request mean
 * anything, and the states the interface has to tell apart.
 *
 * A browser test, because this module reaches `db/project-database.ts` and so PouchDB. That is
 * the right place for it: composition is where the impure things meet, which is exactly why
 * `session.ts` next door holds the policy and stays loadable in plain Node.
 */

const response = (status: number, body?: unknown) =>
  new Response(body === undefined ? null : JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  })

beforeEach(() => {
  forgetTokens()
})

describe('where the back ends are', () => {
  it('addresses both by path, never by host', () => {
    // Production serves them from the application's own origin through Pages Functions;
    // development proxies the same two paths. A host here would be a value to get wrong, and
    // would put an origin into `connect-src` that is currently `'self'` and nothing else.
    expect(API_BASE).toBe('/api')
    expect(COUCH_BASE).toBe('/db')
  })
})

describe('finding out whether this browser has a session', () => {
  it('exchanges the session cookie for a token', async () => {
    const fetchImpl = vi.fn(async () => response(200, { accessToken: 'a.b.c', expiresIn: 3600 }))
    expect(await readSessionState(fetchImpl as unknown as typeof fetch)).toBe('signed-in')
    expect(fetchImpl).toHaveBeenCalledWith(
      '/api/auth/token',
      expect.objectContaining({
        method: 'POST',
      }),
    )
  })

  it('sends the cookie, without which the answer is meaningless', async () => {
    // The session is httpOnly, so the page cannot read it and cannot send it any other way. A
    // request without `credentials` reports "not signed in" for somebody who is.
    const seen: RequestInit[] = []
    const fetchImpl = (async (_url: string, init: RequestInit) => {
      seen.push(init)
      return response(200, { accessToken: 'a.b.c', expiresIn: 3600 })
    }) as unknown as typeof fetch
    await readSessionState(fetchImpl)
    expect(seen[0]).toMatchObject({ credentials: 'include' })
  })

  it('keeps the token, so the next request has one', async () => {
    // Asking and getting are one request: there is no "am I signed in" endpoint, and there does
    // not need to be, because the only way to find out is to try the exchange.
    const fetchImpl = vi.fn(async () => response(200, { accessToken: 'a.b.c', expiresIn: 3600 }))
    await readSessionState(fetchImpl as unknown as typeof fetch)
    expect(accessToken()).toBe('a.b.c')
  })

  it('reports signed out on a 401', async () => {
    const fetchImpl = vi.fn(async () => response(401, { error: 'not signed in' }))
    expect(await readSessionState(fetchImpl as unknown as typeof fetch)).toBe('signed-out')
    expect(accessToken()).toBeUndefined()
  })

  it('treats being unable to reach the server as signed out, not as an error', async () => {
    // This application works offline, and not reaching the API is its ordinary state rather
    // than a session ending. Throwing here would put an error on screen for somebody in a
    // basement whose devices are all present and working.
    const fetchImpl = vi.fn(async () => {
      throw new TypeError('Failed to fetch')
    })
    expect(await readSessionState(fetchImpl as unknown as typeof fetch)).toBe('signed-out')
  })

  it('does not believe a 200 that carries no token', async () => {
    // A status code is not a session. Reporting `signed-in` here would leave the application
    // making requests with no token and blaming the user's session for the 401s that follow.
    const fetchImpl = vi.fn(async () => response(200, {}))
    expect(await readSessionState(fetchImpl as unknown as typeof fetch)).toBe('signed-out')
    expect(accessToken()).toBeUndefined()
  })

  it('does not believe a 200 whose body is not JSON', async () => {
    const fetchImpl = vi.fn(async () => new Response('not json', { status: 200 }))
    expect(await readSessionState(fetchImpl as unknown as typeof fetch)).toBe('signed-out')
    expect(accessToken()).toBeUndefined()
  })
})

describe('starting the sign-in journey', () => {
  it('leaves the page, because the destination is not ours', async () => {
    // Google's consent screen, and a return trip that sets an httpOnly cookie. Neither can
    // happen inside a fetch.
    const go = vi.fn()
    beginSignIn(go)
    expect(go).toHaveBeenCalledWith('/api/auth/google')
  })
})
