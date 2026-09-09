import { describe, expect, it } from 'vitest'
import { securityHeaders } from '../../src/security/headers.js'

const overHttps = securityHeaders(true)
const overHttp = securityHeaders(false)

describe('what every response says', () => {
  it('refuses content-type sniffing', () => {
    // A JSON body a browser decides to treat as HTML is a JSON body that can carry script.
    expect(overHttp['x-content-type-options']).toBe('nosniff')
  })

  it('sends no referrer', () => {
    // **Specific to this service.** The OAuth callback arrives as
    // `/auth/google/callback?code=…&state=…`, and a referrer sent from that page hands the
    // authorization code to whatever it linked to. PKCE makes a stolen code much less useful;
    // not leaking it in the first place is cheaper than relying on that.
    expect(overHttp['referrer-policy']).toBe('no-referrer')
  })

  it('permits nothing at all by default', () => {
    // This service returns JSON. A CSP of `default-src 'none'` costs nothing here and is the
    // difference between an error page that renders someone's markup and one that does not.
    expect(overHttp['content-security-policy']).toContain("default-src 'none'")
  })

  it('cannot be framed', () => {
    expect(overHttp['content-security-policy']).toContain("frame-ancestors 'none'")
    expect(overHttp['x-frame-options']).toBe('DENY')
  })

  it('is never stored by a cache', () => {
    // Every response here is either a user's own data or a credential. A shared cache holding
    // one serves it to whoever asks next.
    expect(overHttp['cache-control']).toBe('no-store')
  })
})

describe('HSTS', () => {
  it('is sent over https', () => {
    expect(overHttps['strict-transport-security']).toContain('max-age=')
  })

  it('is not sent over plain http', () => {
    // A browser ignores it there anyway. Sending it regardless would say this service had
    // checked something it had not.
    expect(overHttp['strict-transport-security']).toBeUndefined()
  })

  it('lasts a year and covers subdomains', () => {
    expect(overHttps['strict-transport-security']).toBe('max-age=31536000; includeSubDomains')
  })

  it('does not ask to be preloaded', () => {
    // `preload` is close to irreversible: removal from the browser list takes months, and it
    // applies to every subdomain of the registered domain, including ones this service knows
    // nothing about. That is the domain owner's decision to make deliberately, not a default
    // to inherit from an API's source code.
    expect(overHttps['strict-transport-security']).not.toContain('preload')
  })
})

describe('what is deliberately absent', () => {
  it('says nothing about cross-origin resource policy', () => {
    // CORP would block the cross-origin reads the application depends on — the browser app is
    // served from a different origin than this API by design — and CORS already governs who
    // may read these responses. A header that has to be set to its most permissive value to
    // keep the product working is a header that is not doing anything.
    expect(overHttp['cross-origin-resource-policy']).toBeUndefined()
  })

  it('says nothing about permissions policy', () => {
    // Features are granted to documents. This service returns no document, and the page that
    // needs the camera is served by Cloudflare Pages, where `_headers` is the place to say so.
    expect(overHttp['permissions-policy']).toBeUndefined()
  })
})
