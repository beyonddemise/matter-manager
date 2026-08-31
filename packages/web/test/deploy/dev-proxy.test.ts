import { describe, expect, it } from 'vitest'
import { devProxy } from '../../vite.config.js'

/**
 * The development proxy, and the two variables that aim it.
 *
 * `/api` and `/db` exist so that development and production agree. In production the application
 * keeps its Cloudflare Pages deployment and Pages Functions forward those two paths to the API
 * and to CouchDB, so the browser only ever addresses its own origin. Development has to match,
 * or the relative URLs the application uses work in exactly one of the two places — and the one
 * they fail in is the one nobody runs before deploying.
 *
 * `devProxy` takes its environment as an argument rather than reading `.env` itself, so these
 * assertions do not depend on whichever file the machine running them happens to have. A test
 * that passes for its author and fails for everybody else is worse than no test.
 */

describe('the development proxy', () => {
  it('serves the API and CouchDB from the application origin', () => {
    // Both, not one. A proxy for the API alone would leave replication addressing CouchDB
    // cross-origin in development and same-origin in production.
    expect(Object.keys(devProxy({})).sort()).toEqual(['/api', '/db'])
  })

  it('strips the prefix, because the API serves its routes at the root', () => {
    // Keeping it would push knowledge of the proxy into every route on both sides.
    expect(devProxy({})['/api'].rewrite('/api/projects')).toBe('/projects')
    expect(devProxy({})['/db'].rewrite('/db/project_local')).toBe('/project_local')
  })

  it('strips only the leading prefix', () => {
    // `/api/things/api-key` contains the word twice, and only the first is the mount point.
    expect(devProxy({})['/api'].rewrite('/api/things/api-key')).toBe('/things/api-key')
  })

  it('has somewhere to point when nothing is configured', () => {
    // `npm run dev:stack` puts them here, so a fresh clone with no .env still works.
    expect(devProxy({})['/api'].target).toBe('http://localhost:3000')
    expect(devProxy({})['/db'].target).toBe('http://localhost:5985')
  })

  it('reads both variables, so neither is documented and ignored', () => {
    // L28: an environment variable is wired when something *reads* it. Documenting one in
    // .env.example and plumbing it through a compose file are the steps that make its absence
    // harder to notice, not steps towards it being used.
    const env = {
      DEV_API_TARGET: 'http://api.test:9000',
      DEV_COUCHDB_TARGET: 'http://db.test:9001',
    }
    expect(devProxy(env)['/api'].target).toBe('http://api.test:9000')
    expect(devProxy(env)['/db'].target).toBe('http://db.test:9001')
  })

  it('falls back when a variable is present but empty', () => {
    // A deployment tool that renders `DEV_API_TARGET=` for an unset value should get the
    // default, not an empty target that fails at the first request. `composition.ts` in the API
    // treats empty and absent the same way for the same reason.
    expect(devProxy({ DEV_API_TARGET: '' })['/api'].target).toBe('http://localhost:3000')
  })
})
