import { describe, expect, it } from 'vitest'
import { prefixFor, stripPrefix, targets, upstreamUrl } from '../../../functions/_lib/forward.js'
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

describe('the URL actually fetched', () => {
  it('joins the origin, the stripped path and the query', () => {
    expect(upstreamUrl('https://api.example', '/projects', '?limit=10')).toBe(
      'https://api.example/projects?limit=10',
    )
  })

  it('trims a trailing slash from the origin', () => {
    // COUCHDB_URL is set on the live project *with* a trailing slash. Concatenating gives
    // `https://couch.matter-manager.io//project_local`, and an empty first path segment is a
    // different route to CouchDB, not a cosmetic difference. The literal below is the deployed
    // value, not a tidied one, because a tidied one would leave this untested.
    expect(upstreamUrl('https://couch.matter-manager.io/', '/project_local', '')).toBe(
      'https://couch.matter-manager.io/project_local',
    )
  })

  it('trims however many slashes there are', () => {
    expect(upstreamUrl('https://db.example///', '/x', '')).toBe('https://db.example/x')
  })

  it('turns the bare prefix into the root', () => {
    // `stripPrefix('/db', '/db')` is '', and `https://db.example?x` is not the root with a
    // query - it is a URL whose path is empty, which CouchDB and the API both read differently
    // from `/`.
    expect(upstreamUrl('https://db.example', '', '')).toBe('https://db.example/')
    expect(upstreamUrl('https://db.example', '', '?a=1')).toBe('https://db.example/?a=1')
  })

  it('keeps the query string', () => {
    // Replication is `_changes?since=…&feed=longpoll&heartbeat=…`. A forwarder that rebuilt
    // the URL from the pathname alone would serve /api/healthz perfectly and break every
    // replication request, which is the sort of bug that gets diagnosed as "CouchDB is slow".
    expect(
      upstreamUrl('https://db.example', '/project_local/_changes', '?feed=longpoll&since=42'),
    ).toBe('https://db.example/project_local/_changes?feed=longpoll&since=42')
  })

  it('does not re-encode what the browser already encoded', () => {
    // The pathname arrives percent-encoded from `new URL(request.url).pathname`. Running it
    // through URL construction again would double-encode a document id containing a space or
    // a slash, and PouchDB document ids routinely contain both.
    expect(upstreamUrl('https://db.example', '/project_local/a%20b%2Fc', '')).toBe(
      'https://db.example/project_local/a%20b%2Fc',
    )
  })
})
