import PouchDB from 'pouchdb-browser'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { API_BASE, beginSignIn, COUCH_BASE, endSession } from '../../src/ui/composition.js'
import { forgetTokens, pouchRefreshTokenStore, rememberAccessToken } from '../../src/ui/tokens.js'

/**
 * #120: seven modules were written, tested, and imported by nothing but their own tests. Every
 * one was correct; what was missing was the file that constructs them.
 *
 * These tests are about that file, so they exercise it rather than the modules underneath —
 * those have their own suites, and repeating them here would only mean two places to update.
 * What is checked is the wiring: the right paths. The token exchange itself is in
 * `request-tokens.browser.test.ts`.
 *
 * A browser test, because this module reaches `db/project-database.ts` and so PouchDB. That is
 * the right place for it: composition is where the impure things meet, which is exactly why
 * `session.ts` next door holds the policy and stays loadable in plain Node.
 */

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

describe('starting the sign-in journey', () => {
  it('leaves the page, because the destination is not ours', async () => {
    // Google's consent screen, and a return trip that sets an httpOnly cookie. Neither can
    // happen inside a fetch.
    const go = vi.fn()
    beginSignIn(go)
    expect(go).toHaveBeenCalledWith('/api/auth/google')
  })
})

describe('signing out through the real path', () => {
  it('shows the server the refresh token and the bearer that sign-out discards locally', async () => {
    // `signOut` forgets both before it asks the server to revoke anything, so they have to be
    // captured first. Without that the request carries neither and revokes nothing. A real
    // PouchDB-backed store, on a database of its own so the sign-out's destruction of `mm-local`
    // does not interfere.
    const db = new PouchDB(`refresh-token-test-${crypto.randomUUID()}`)
    const store = pouchRefreshTokenStore(db)
    await store.write('r1')
    rememberAccessToken({ accessToken: 'access-1', expiresIn: 3600 })
    const requests: Array<{ url: string; init: RequestInit }> = []
    const fetchImpl = (async (url: string, init: RequestInit) => {
      requests.push({ url, init })
      return new Response(null, { status: 204 })
    }) as unknown as typeof fetch

    expect(await endSession(false, fetchImpl, store)).toEqual([])

    expect(requests).toHaveLength(1)
    expect(requests[0]?.url).toBe('/api/auth/signout')
    expect(JSON.parse(String(requests[0]?.init.body))).toEqual({ refreshToken: 'r1' })
    expect(requests[0]?.init.headers).toMatchObject({ authorization: 'Bearer access-1' })
    expect(await store.read()).toBeUndefined()
    await db.destroy()
  })
})
