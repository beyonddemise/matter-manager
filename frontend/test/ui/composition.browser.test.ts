import { beforeEach, describe, expect, it, vi } from 'vitest'
import { API_BASE, beginSignIn, COUCH_BASE } from '../../src/ui/composition.js'
import { forgetTokens } from '../../src/ui/tokens.js'

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
