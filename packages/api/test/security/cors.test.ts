import { describe, expect, it } from 'vitest'
import {
  ALLOWED_HEADERS,
  ALLOWED_METHODS,
  corsHeaders,
  corsPolicy,
} from '../../src/security/cors.js'

const POLICY = corsPolicy(['https://matter.example', 'http://localhost:5173'])

/** The headers a simple (non-preflight) request would receive. */
const simple = (origin: string | undefined) => corsHeaders(origin, false, POLICY)

/** The headers a preflight would receive. */
const preflight = (origin: string | undefined) => corsHeaders(origin, true, POLICY)

describe('an origin on the list', () => {
  it('is echoed back exactly', () => {
    // Echoed rather than `*`, because `*` and credentials are mutually exclusive — and the
    // session cookie is the entire reason the browser is asking.
    expect(simple('https://matter.example')['access-control-allow-origin']).toBe(
      'https://matter.example',
    )
  })

  it('is allowed to send the cookie', () => {
    expect(simple('https://matter.example')['access-control-allow-credentials']).toBe('true')
  })

  it('is never answered with a wildcard', () => {
    // A wildcard with credentials is rejected by browsers, so the failure would look like a
    // CORS bug rather than what it is: an attempt to open the API to every origin at once.
    expect(Object.values(simple('https://matter.example'))).not.toContain('*')
  })
})

describe('an origin that is not on the list', () => {
  it('gets no permission at all', () => {
    // Not a 403, and not an error body: no header. The browser is the enforcement point, and
    // the absence of the header is what stops it. Echoing the origin with a refusal *in the
    // body* would be a pass, because the header is what is checked.
    expect(simple('https://evil.example')['access-control-allow-origin']).toBeUndefined()
  })

  it('is not matched by being a prefix of one that is', () => {
    // `https://matter.example.evil.test` starts with an allowed origin. So does
    // `https://matter.examplely`. Anything short of an exact comparison lets one of them in.
    expect(
      simple('https://matter.example.evil.test')['access-control-allow-origin'],
    ).toBeUndefined()
  })

  it('is not matched by containing one', () => {
    expect(
      simple('https://evil.test/?x=https://matter.example')['access-control-allow-origin'],
    ).toBeUndefined()
  })

  it('is not matched by differing only in scheme', () => {
    // http:// where https:// was configured is a downgrade, and an attacker on the network can
    // supply the http:// page.
    expect(simple('http://matter.example')['access-control-allow-origin']).toBeUndefined()
  })

  it('is not matched by differing only in port', () => {
    expect(simple('http://localhost:5174')['access-control-allow-origin']).toBeUndefined()
  })

  it('is never `null`', () => {
    // `Origin: null` comes from a sandboxed iframe, a `file://` page or some redirects — every
    // page that has one is a page that could not have been vouched for.
    expect(simple('null')['access-control-allow-origin']).toBeUndefined()
  })
})

describe('a request with no origin at all', () => {
  it('gets no CORS headers', () => {
    // curl, a health check, a same-origin fetch. There is nothing to permit: CORS headers only
    // ever *relax* the browser's rules, and there is no browser here to relax them for.
    expect(simple(undefined)).toEqual({ vary: 'Origin' })
  })
})

describe('what caches are told', () => {
  it('says the answer depends on the origin, even when it allowed one', () => {
    expect(simple('https://matter.example').vary).toBe('Origin')
  })

  it('says so when it refused one too', () => {
    // **The one that bites.** Without `Vary`, a shared cache can hand the permissive answer it
    // stored for the real application to a request from anywhere else — the allowlist is then
    // enforced only until something caches a response.
    expect(simple('https://evil.example').vary).toBe('Origin')
  })

  it('says so when there was no origin', () => {
    expect(simple(undefined).vary).toBe('Origin')
  })
})

describe('a preflight', () => {
  it('names the methods this service answers', () => {
    expect(preflight('https://matter.example')['access-control-allow-methods']).toBe(
      ALLOWED_METHODS.join(', '),
    )
  })

  it('names the headers a page may send', () => {
    expect(preflight('https://matter.example')['access-control-allow-headers']).toBe(
      ALLOWED_HEADERS.join(', '),
    )
  })

  it('lets the browser remember the answer for a while', () => {
    expect(Number(preflight('https://matter.example')['access-control-max-age'])).toBeGreaterThan(0)
  })

  it('tells an origin that is not on the list nothing', () => {
    expect(preflight('https://evil.example')['access-control-allow-methods']).toBeUndefined()
  })

  it('does not offer methods on an ordinary request', () => {
    // They mean nothing outside a preflight, and a header that means nothing is a header
    // somebody will one day read as though it meant something.
    expect(simple('https://matter.example')['access-control-allow-methods']).toBeUndefined()
  })
})

describe('the configured list itself', () => {
  it('tolerates a trailing slash, because a person will write one', () => {
    const policy = corsPolicy(['https://matter.example/'])

    expect(
      corsHeaders('https://matter.example', false, policy)['access-control-allow-origin'],
    ).toBe('https://matter.example')
  })

  it('refuses a wildcard outright', () => {
    // Not "supported and discouraged". An API that carries a session cookie has no correct use
    // for one, and a deployment that sets `*` believing it works would carry that belief into
    // production.
    expect(() => corsPolicy(['*'])).toThrow(/wildcard/i)
  })

  it('refuses a subdomain pattern, which is the wildcard somebody actually writes', () => {
    // `https://*.matter.example` parses as a perfectly good URL with a strange host, so nothing
    // else here would object to it — and no browser ever sends an Origin that matches it. It
    // would refuse every subdomain it was written to allow, in production, quietly.
    expect(() => corsPolicy(['https://*.matter.example'])).toThrow(/wildcard/i)
  })

  it('refuses anything with a path', () => {
    // An origin is a scheme, a host and a port. A configured value with a path never matches
    // anything a browser sends, so it fails silently — the API simply refuses the application
    // it was meant to allow, in production, with no message anywhere.
    expect(() => corsPolicy(['https://matter.example/app'])).toThrow(/origin/i)
  })

  it('refuses something that is not a URL', () => {
    expect(() => corsPolicy(['matter.example'])).toThrow(/origin/i)
  })

  it('allows nothing when nothing is configured', () => {
    // The safe end of the range: no origins means no cross-origin access, not "any".
    expect(corsHeaders('https://matter.example', false, corsPolicy([]))).toEqual({ vary: 'Origin' })
  })
})
