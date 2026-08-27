/**
 * The headers every response carries.
 *
 * Written out rather than pulled in (ADR 0013): the useful part of a helmet-style library is
 * the *list*, and a list whose every entry has a reason next to it is worth more here than one
 * that arrives with fifteen entries, four of which apply to a service that returns HTML and one
 * of which is about Flash.
 *
 * @module
 */

/** A year. The conventional HSTS lifetime, and long enough to mean something. */
const HSTS_MAX_AGE = 31_536_000

/**
 * A policy for a service that returns JSON and nothing else.
 *
 * `default-src 'none'` covers every fetch directive at once. The rest are the directives that
 * `default-src` does **not** cover, which is exactly the mistake this spells out to avoid:
 * `frame-ancestors`, `base-uri` and `form-action` all fall back to nothing rather than to
 * `default-src`, so a policy that lists only `default-src` leaves all three unrestricted.
 */
const CONTENT_SECURITY_POLICY = [
  "default-src 'none'",
  "frame-ancestors 'none'",
  "base-uri 'none'",
  "form-action 'none'",
].join('; ')

/**
 * The security headers for one response.
 *
 * @param secure whether the request arrived over TLS. Only HSTS depends on it, and only because
 *   a browser ignores that header over plain http — sending it anyway would claim a check this
 *   service had not made.
 */
export function securityHeaders(secure: boolean): Record<string, string> {
  const headers: Record<string, string> = {
    // A JSON body that a browser decides to treat as HTML is a JSON body that can carry script.
    'x-content-type-options': 'nosniff',

    // The OAuth callback arrives as `/auth/google/callback?code=…&state=…`. A referrer sent
    // from that page hands the authorization code to whatever it linked to.
    'referrer-policy': 'no-referrer',

    'content-security-policy': CONTENT_SECURITY_POLICY,

    // Redundant beside `frame-ancestors` for anything current, and kept for what is not.
    'x-frame-options': 'DENY',

    // Every response here is a user's own data or a credential. A shared cache holding one
    // serves it to whoever asks next. Routes that need something else set it themselves — this
    // is a default, applied only where nothing was said.
    'cache-control': 'no-store',
  }

  if (secure) {
    // No `preload`. It is close to irreversible, and it applies to every subdomain of the
    // registered domain including ones this service knows nothing about — the domain owner's
    // decision, not one to inherit from an API's source.
    headers['strict-transport-security'] = `max-age=${HSTS_MAX_AGE}; includeSubDomains`
  }

  return headers
}
