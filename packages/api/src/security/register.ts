/**
 * Where the security policies meet Fastify.
 *
 * Three hooks and no routes. The preflight in particular is answered from `onRequest` rather
 * than by registering `OPTIONS *`, for two reasons: a registered route would appear in
 * `registeredRoutes()` as an operation the contract does not declare — turning the drift check
 * (#39) into a check on Fastify's plumbing — and a preflight for a path that has no route would
 * otherwise 404, which tells a browser the request is forbidden rather than that the endpoint is
 * not deployed.
 *
 * @module
 */

import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import { type CorsPolicy, corsHeaders, corsPolicy } from './cors.js'
import { securityHeaders } from './headers.js'
import { type Limit, rateLimiter } from './rate-limit.js'

/** The endpoints that are rate limited, and how. */
export interface Limits {
  /**
   * Signing in and out.
   *
   * Rare per user and expensive per attempt — each one may reach Google — so the limit can be
   * low without inconveniencing anybody who is not guessing.
   */
  readonly auth: Limit
  /**
   * Exchanging the session cookie for an access token.
   *
   * Used at a completely different rate: a page refreshes this for as long as it stays open.
   * A single counter shared with sign-in would either throttle an ordinary session or fail to
   * throttle a sign-in attempt.
   */
  readonly token: Limit
}

/** How the service is protected. */
export interface SecurityOptions {
  /**
   * The origins allowed to make cross-origin requests.
   *
   * Empty means none, which is the safe end: a deployment that forgot to configure this should
   * refuse the application rather than admit the internet.
   */
  readonly origins?: readonly string[]
  readonly limits?: Limits
  /** The clock, in seconds. Injected so a test does not wait for a window to pass. */
  readonly now?: () => number
}

/** Twenty sign-in attempts in five minutes is far more than a person, and far less than a script. */
export const DEFAULT_LIMITS: Limits = {
  auth: { max: 20, windowSeconds: 300 },
  token: { max: 60, windowSeconds: 300 },
}

/** The path prefix whose endpoints are limited. */
const AUTH_PREFIX = '/auth/'

/** The one auth endpoint that gets its own budget. */
const TOKEN_PATH = '/auth/token'

/** The path, without the query string. Rate limits are per endpoint, not per URL. */
const pathOf = (url: string): string => url.split('?')[0] ?? url

/**
 * Whether the request reached this process over TLS.
 *
 * `request.protocol` already accounts for `X-Forwarded-Proto` when `trustProxy` is on, and
 * ignores it when it is not — which is the right way round: an untrusted proxy header claiming
 * `https` would otherwise be enough to make this service send HSTS on a plain connection.
 */
const isSecure = (request: FastifyRequest): boolean => request.protocol === 'https'

/**
 * Puts the headers on the reply.
 *
 * No "only if unset" guard, because there is nothing to guard against: this runs in `onRequest`,
 * before any handler, so a route that sets its own `cache-control` writes over the default
 * simply by running later. A guard here would be unreachable — and an unreachable guard reads
 * like a decision somebody made, which is worse than no guard at all.
 */
function applyHeaders(reply: FastifyReply, headers: Record<string, string>): void {
  for (const [name, value] of Object.entries(headers)) reply.header(name, value)
}

/**
 * Installs the security hooks.
 *
 * Order matters and is the reason this is one function rather than three: the headers go on
 * **first**, so that they are already on the reply when the rate limiter short-circuits it. A
 * 429 without the cross-origin headers is reported to a page as a CORS failure, so the
 * application says "something went wrong" instead of "wait a minute" — and the user retries,
 * which is the one thing the limit was asking them not to do.
 */
export function registerSecurity(app: FastifyInstance, options: SecurityOptions): void {
  // Validated here rather than trusted: `corsPolicy` throws on a wildcard, on a value with a
  // path, and on anything that is not a URL. Startup is the only moment somebody is in a
  // position to notice, because the alternative failure — the real application being refused —
  // looks exactly like a browser problem and happens only in production.
  const policy: CorsPolicy = corsPolicy(options.origins ?? [])
  const limits = options.limits ?? DEFAULT_LIMITS
  const authLimiter = rateLimiter(limits.auth, options.now)
  const tokenLimiter = rateLimiter(limits.token, options.now)

  app.addHook('onRequest', async (request, reply) => {
    const origin = request.headers.origin
    const isPreflight =
      request.method === 'OPTIONS' && request.headers['access-control-request-method'] !== undefined

    applyHeaders(reply, securityHeaders(isSecure(request)))
    applyHeaders(reply, corsHeaders(origin, isPreflight, policy))

    // Answered here, before the router. See the module note for why it is not a route.
    if (isPreflight) return reply.code(204).send()

    const path = pathOf(request.url)
    if (!path.startsWith(AUTH_PREFIX)) return

    const isToken = path === TOKEN_PATH
    const limiter = isToken ? tokenLimiter : authLimiter
    // Keyed on the **bucket** and the address, never on the path. This hook runs before the
    // router, so the path is any string the client sent — and a per-path key lets one address
    // create an unbounded number of entries in a map that refuses *new* keys once it is full
    // and evicts nothing within a window. A few thousand requests to `/auth/<random>` would
    // then deny sign-in to every client not already counted, for as long as the attacker keeps
    // refilling it. Bounded by the number of addresses, this cannot happen.
    const decision = limiter.check(`${isToken ? 'token' : 'auth'}:${request.ip}`)
    if (decision.allowed) return

    reply.header('retry-after', String(decision.retryAfterSeconds))
    // Nothing about which limit, which window, or how much is left. This is an unauthenticated
    // endpoint, and every number is a hint about what else would work.
    return reply.code(429).send({ error: 'too many requests' })
  })
}
