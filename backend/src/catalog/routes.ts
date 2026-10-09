/**
 * `POST /catalog/lookup`: the manufacturer and product behind a setup code.
 *
 * **The one route that receives a setup code** (ADR 0019). It decodes the code in memory, keeps
 * the two IDs, and lets the code go: it is never stored, never logged, and never in a response.
 * The redaction list carries `code` for the case where somebody logs a request body anyway.
 *
 * Authenticated with the access token, like every route but sign-in, and open to **every plan**:
 * the answer is public catalogue data and costs this service no storage of the caller's own.
 *
 * @module
 */

import type { FastifyInstance } from 'fastify'
import { bearerClaims } from '../auth/bearer.js'
import type { DenyList } from '../auth/deny-list.js'
import type { SigningKey } from '../auth/jwt.js'
import type { CouchClient } from '../couch/client.js'
import { problem } from '../problem.js'
import { type Limit, rateLimiter } from '../security/rate-limit.js'
import type { DclClient } from './dcl.js'
import { CodeError, type CodeIds, decodeCode } from './decode.js'
import { lookupEntries } from './lookup.js'
import { isTestVendor, testVendorLookup, toLookup } from './policy.js'
import { catalogStore } from './store.js'

/** What the catalogue route needs. */
export interface CatalogDependencies {
  /** Where `matter_catalog` lives. The same client the other routes use. */
  readonly couch: CouchClient
  /** The key the access token is verified with — the one CouchDB validates it with. */
  readonly key: SigningKey
  /** Access tokens signed out before their expiry. */
  readonly deny?: DenyList
  readonly dcl: DclClient
  /** Lookups per subject per window. `buildServer` passes `Limits.catalog`. */
  readonly limit: Limit
  /** The clock in seconds, for token verification and the rate limit. */
  readonly now?: () => number
  /** The clock as a date, for freshness and `fetchedAt`. */
  readonly clock?: () => Date
}

/** Registers `POST /catalog/lookup`. */
export function registerCatalogRoutes(app: FastifyInstance, deps: CatalogDependencies): void {
  const now = deps.now ?? (() => Math.floor(Date.now() / 1000))
  const clock = deps.clock ?? (() => new Date())
  const store = catalogStore(deps.couch)
  // Per subject, and in the handler rather than in `registerSecurity`'s hook. That hook runs
  // before routing with no key to verify a token with, so all it could count is the address — and
  // an address is shared by a household or an office, while the abuse this guards against is one
  // *account* using the endpoint as a free DCL proxy. Counting after authentication also means
  // unauthenticated requests cannot spend a signed-in user's budget.
  const limiter = rateLimiter(deps.limit, now)

  app.post('/catalog/lookup', async (request, reply) => {
    const caller = bearerClaims(request, deps.key, now, deps.deny)
    if (caller === undefined) return problem(reply, { title: 'Not signed in', status: 401 })

    const decision = limiter.check(`catalog:${caller.sub}`)
    if (!decision.allowed) {
      reply.header('retry-after', String(decision.retryAfterSeconds))
      return problem(reply, { title: 'Too many requests', status: 429 })
    }

    const code = (request.body as { code?: unknown } | undefined)?.code
    if (typeof code !== 'string') return problem(reply, { title: 'Not a setup code', status: 400 })

    let ids: CodeIds
    try {
      ids = decodeCode(code)
    } catch (error) {
      if (!(error instanceof CodeError)) throw error
      // Fixed titles, and never the error's message: the client switches on the status, and a
      // title built from the input is how a code would find its way into a response.
      return error.kind === 'no-ids'
        ? problem(reply, { title: 'No vendor or product id in this code', status: 422 })
        : problem(reply, { title: 'Not a setup code', status: 400 })
    }

    // Per caller in effect: the body is public data, but the request carried a credential.
    reply.header('cache-control', 'private, no-store')

    // Both answers are `CatalogLookup`, the contract's schema, by `policy.ts`'s return types: a
    // shape the contract does not declare will not compile there.
    if (isTestVendor(ids.vendorId)) return testVendorLookup(ids.vendorId, ids.productId, clock())

    const result = await lookupEntries(ids, {
      store,
      dcl: deps.dcl,
      now: clock,
      // The IDs only. The code never reaches this function, so it cannot reach a log line.
      warn: (context, message) => request.log.warn(context, message),
    })
    if (result === undefined) {
      return problem(reply, { title: 'Catalogue unavailable', status: 503 })
    }

    return toLookup(result)
  })
}
