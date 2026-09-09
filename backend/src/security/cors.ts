/**
 * Cross-origin access, restricted to the origins this deployment knows about.
 *
 * The browser is the enforcement point: these headers only ever *relax* the same-origin policy,
 * and withholding them is what refuses a caller. So there is no 403 to return and no error body
 * to write — an origin that is not on the list simply gets no permission, and the browser does
 * the rest.
 *
 * Everything here is a string comparison and a `URL`, so it is written out rather than pulled in
 * (ADR 0013). The parts worth getting right are the parts a library would not decide for us
 * anyway: an **exact** origin comparison, `Vary: Origin` on every answer including the refusals,
 * and no wildcard, ever, because the session travels as a cookie.
 *
 * @module
 */

/** The methods this service answers. Sent only in a preflight, where they mean something. */
export const ALLOWED_METHODS = ['GET', 'POST', 'PUT', 'OPTIONS'] as const

/**
 * The request headers a page may send.
 *
 * No `authorization`: the CouchDB access token goes to CouchDB, not here, and offering to
 * accept one would invite a page to send it to the wrong service.
 */
export const ALLOWED_HEADERS = ['content-type', 'accept'] as const

/** How long a browser may remember a preflight, in seconds. */
export const PREFLIGHT_MAX_AGE = 600

/** The origins a deployment trusts. Built by {@link corsPolicy}, which validates them. */
export interface CorsPolicy {
  readonly allowedOrigins: readonly string[]
}

/**
 * Validates and normalises the configured origins.
 *
 * Throws rather than dropping what it does not understand. A misconfigured allowlist fails in
 * exactly one way — the real application is refused, in production, silently — and the only
 * moment anybody is in a position to notice is startup.
 *
 * @throws {Error} on a wildcard, on anything carrying a path, and on anything that is not a URL
 */
export function corsPolicy(origins: readonly string[]): CorsPolicy {
  return {
    allowedOrigins: origins.map((configured) => {
      if (configured.includes('*')) {
        throw new Error(
          `CORS origin "${configured}": a wildcard is not allowed. This API carries a session ` +
            'cookie, so * would be rejected by every browser, and a pattern such as ' +
            'https://*.example is not a thing an Origin header ever contains — it would simply ' +
            'never match. List the origins.',
        )
      }

      let parsed: URL
      try {
        parsed = new URL(configured)
      } catch {
        throw new Error(`CORS origin "${configured}" is not a URL: expected https://host[:port].`)
      }

      // `URL.origin` is already the scheme, host and port with nothing else, which is exactly
      // what a browser sends. Comparing against it is what makes the match exact.
      if (parsed.pathname !== '/' || parsed.search !== '' || parsed.hash !== '') {
        throw new Error(
          `CORS origin "${configured}" has a path: an origin is a scheme, a host and a port, ` +
            'and a value with anything more can never match what a browser sends.',
        )
      }

      return parsed.origin
    }),
  }
}

/**
 * The CORS headers for one request.
 *
 * `Vary: Origin` is on **every** answer, including the ones that permit nothing. Without it a
 * shared cache may hand the permissive response stored for the real application to a request
 * from somewhere else, and the allowlist is then enforced only until something caches.
 *
 * @param origin the request's `Origin` header, or `undefined` when it has none — curl, a health
 *   check, a same-origin fetch. There is nothing to permit and nothing to refuse.
 * @param isPreflight whether this is the `OPTIONS` probe that precedes the real request
 */
export function corsHeaders(
  origin: string | undefined,
  isPreflight: boolean,
  policy: CorsPolicy,
): Record<string, string> {
  const headers: Record<string, string> = { vary: 'Origin' }

  // An exact comparison. Prefix or substring matching lets `https://matter.example.evil.test`
  // through, and `Origin: null` — a sandboxed iframe, a `file://` page — is a value, not an
  // absence, so it has to fail the same comparison rather than be treated as "no origin".
  if (origin === undefined || !policy.allowedOrigins.includes(origin)) return headers

  headers['access-control-allow-origin'] = origin
  headers['access-control-allow-credentials'] = 'true'

  if (isPreflight) {
    headers['access-control-allow-methods'] = ALLOWED_METHODS.join(', ')
    headers['access-control-allow-headers'] = ALLOWED_HEADERS.join(', ')
    headers['access-control-max-age'] = String(PREFLIGHT_MAX_AGE)
  }

  return headers
}
