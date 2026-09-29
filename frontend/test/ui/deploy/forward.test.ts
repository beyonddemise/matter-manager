import { describe, expect, it } from 'vitest'
import { prefixFor, stripPrefix, targets } from '../../../functions/_lib/forward.js'
import { devProxy } from '../../../vite.config.js'

/**
 * The production forwarder, tested the way `dev-proxy.test.ts` tests its counterpart: by
 * handing the module an environment rather than letting it read one. The reason is the same
 * and is worth repeating — a test that reads the machine's own `.env` passes for its author
 * and fails for everybody else.
 */

describe('where each prefix points', () => {
  it('covers the same two prefixes the development proxy does', () => {
    expect(Object.keys(targets({})).sort()).toEqual(['/api', '/db'])
  })

  it('reads API_ORIGIN for /api and COUCHDB_URL for /db', () => {
    const env = { API_ORIGIN: 'https://api.example', COUCHDB_URL: 'https://db.example' }
    expect(targets(env)['/api'].origin).toBe('https://api.example')
    expect(targets(env)['/db'].origin).toBe('https://db.example')
  })

  it('names the variable that aims it, so a 502 can say which one is missing', () => {
    expect(targets({})['/api'].variable).toBe('API_ORIGIN')
    expect(targets({})['/db'].variable).toBe('COUCHDB_URL')
  })

  it('treats a variable that is present but empty as absent', () => {
    // A dashboard field saved blank, or a deployment tool rendering an unset value, produces
    // an empty string rather than an absent key. `composition.ts` and `devProxy` both make
    // this same equation; a forwarder that did not would fetch `/auth/google` with no origin.
    expect(targets({ API_ORIGIN: '' })['/api'].origin).toBe('')
    expect(targets({ API_ORIGIN: '   ' })['/api'].origin).toBe('')
  })

  it('maps each upstream to its prefix', () => {
    expect(prefixFor('api')).toBe('/api')
    expect(prefixFor('db')).toBe('/db')
  })
})

describe('stripping the prefix', () => {
  it('removes it, because the API serves its routes at the root', () => {
    expect(stripPrefix('/api/projects', '/api')).toBe('/projects')
    expect(stripPrefix('/db/project_local', '/db')).toBe('/project_local')
  })

  it('strips only the leading prefix', () => {
    // `/api/things/api-key` contains the word twice, and only the first is the mount point.
    expect(stripPrefix('/api/things/api-key', '/api')).toBe('/things/api-key')
  })

  it('leaves the empty string for the bare prefix, exactly as Vite does', () => {
    // Turning it into `/` is `upstreamUrl`'s job (Task 2), deliberately: this function has a
    // counterpart in vite.config.ts and the parity test below compares them character for
    // character. A normalisation applied here and not there would be a real divergence
    // reported as a passing test.
    expect(stripPrefix('/api', '/api')).toBe('')
    expect(stripPrefix('/db', '/db')).toBe('')
  })
})

describe('parity with the development proxy', () => {
  // Development and production are two implementations of one contract. Nothing but this
  // assertion stops them drifting, and a drift is invisible in both places: each works.
  it('agrees on which prefixes exist', () => {
    expect(Object.keys(targets({})).sort()).toEqual(Object.keys(devProxy({})).sort())
  })

  it('agrees on what stripping a prefix leaves', () => {
    const paths = ['/api', '/api/', '/api/projects', '/api/things/api-key', '/api/auth/google']
    for (const path of paths) {
      expect(stripPrefix(path, '/api')).toBe(devProxy({})['/api'].rewrite(path))
    }
    for (const path of ['/db', '/db/', '/db/project_local', '/db/_changes']) {
      expect(stripPrefix(path, '/db')).toBe(devProxy({})['/db'].rewrite(path))
    }
  })
})
