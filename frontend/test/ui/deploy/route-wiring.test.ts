import { describe, expect, it } from 'vitest'

/**
 * Pins which upstream each route file passes to `forward`.
 *
 * `check-deploy-routes.test.ts` proves the route files exist on disk and that `_routes.json`
 * reaches them; it never imports either one, so the `kind` string each passes — `'api'` or
 * `'db'` — was verified by a human reading the compiled Worker once (recorded in the ledger)
 * and by nothing mechanical since. Finding 5 of the whole-branch review: a swap here is loud in
 * production — `/api` traffic sent to CouchDB breaks sign-in immediately, `/db` traffic sent to
 * the API 404s visibly — but "loud in production" is not the same as "caught before merge".
 *
 * Each test calls `onRequest` with an environment missing the *other* upstream's variable, so
 * `forward`'s own `missingTarget` 502 fires without any fetch — the 502's own text names the
 * variable it went looking for, which is the proof of which `kind` the route passed. A dynamic
 * `await import()` is used rather than a static one because the specifier contains literal
 * square brackets (`[[path]]`), which a static import makes an awkward thing to depend on the
 * resolver handling; dynamic import sidesteps the question entirely.
 */

function incoming(url: string): Request {
  return new Request(url)
}

describe('the two route files are wired to the right upstream', () => {
  it('the /api route asks for API_ORIGIN, not COUCHDB_URL', async () => {
    const { onRequest } = await import('../../../functions/api/[[path]].js')
    const response = await onRequest({
      request: incoming('https://app.matter-manager.io/api/x'),
      env: { COUCHDB_URL: 'https://couch.example' },
    })
    expect(response.status).toBe(502)
    expect(await response.text()).toContain('API_ORIGIN')
  })

  it('the /db route asks for COUCHDB_URL, not API_ORIGIN', async () => {
    const { onRequest } = await import('../../../functions/db/[[path]].js')
    const response = await onRequest({
      request: incoming('https://app.matter-manager.io/db/x'),
      env: { API_ORIGIN: 'https://api.example' },
    })
    expect(response.status).toBe(502)
    expect(await response.text()).toContain('COUCHDB_URL')
  })
})
