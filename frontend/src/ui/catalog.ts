/**
 * The catalogue lookup: manufacturer and product for a setup code, from our own API.
 *
 * **The code goes to our API, in a POST body.** It is a secret (it contains the passcode), so it
 * never appears in a URL, a log or an error. The backend decodes it in memory and sends only
 * vendor and product ids to the DCL (spec §Security). Nothing here writes to the console.
 *
 * **Test-vendor codes never leave the device** ({@link answeringTestVendors}, #238): the server
 * would answer them without the DCL anyway, so they are answered here.
 *
 * **One rate-limit budget per account.** The API counts lookups per signed-in user, 120 in any
 * 300 seconds (`catalog` in `backend/src/security/register.ts`), and the add form and backfill
 * draw on that one budget: a long backfill pass can leave the add form `rate-limited`, and the
 * form then saves without names, which the next backfill run fills in. Backfill's one request a
 * second is what keeps a pass inside the budget; test-vendor codes cost nothing from it.
 *
 * **It never throws.** Every caller treats a failed lookup the same way (save without names, let
 * backfill catch up), so a failure is an outcome to switch on, not an exception to remember to
 * catch. The status decides the outcome, never the problem title.
 *
 * @module
 */

import { type CatalogLookup, testVendorAnswer } from '../domain/index.js'

/** What a lookup came to. */
export type LookupOutcome =
  | { readonly kind: 'found'; readonly lookup: CatalogLookup }
  /** No token, or the API said 401. */
  | { readonly kind: 'signed-out' }
  /** 429: wait this long before the next request. */
  | { readonly kind: 'rate-limited'; readonly retryAfterSeconds: number }
  /** A network error, an abort, a 5xx, or an answer that is not a catalogue answer. */
  | { readonly kind: 'unavailable' }
  /** 400 or 422: the code cannot be looked up, now or later. */
  | { readonly kind: 'unusable' }

/** How lookups are made. Injected so views and backfill test without a server. */
export interface CatalogApi {
  lookup(code: string, signal?: AbortSignal): Promise<LookupOutcome>
}

/**
 * The `window` event a view dispatches to ask the shell for a backfill run (#238).
 *
 * The add form sends it after saving a device its lookup did not answer, so the names arrive
 * now rather than at the next sign-in, reconnect or project switch. An event rather than a call
 * because the shell owns backfill and its guards (session, network, sign-out under way), and a
 * view cannot see them; `PROJECT_CHANGED` reaches the shell the same way.
 */
export const BACKFILL_WANTED = 'matter-manager:catalog-backfill-wanted'

/** Used when a 429 carries no usable `retry-after` (absent, zero, or an HTTP date). */
export const DEFAULT_RETRY_AFTER_SECONDS = 60

/** The longest wait honoured, so one bad header cannot park backfill for a day. */
const MAX_RETRY_AFTER_SECONDS = 3600

const UNAVAILABLE: LookupOutcome = { kind: 'unavailable' }
const SOURCES: readonly unknown[] = ['dcl', 'test-vendor', 'missing']

/** Seconds to wait from a `retry-after` header given in seconds. */
export function retryAfterSeconds(header: string | null): number {
  const seconds = header === null ? Number.NaN : Number(header)
  if (!Number.isFinite(seconds) || seconds <= 0) return DEFAULT_RETRY_AFTER_SECONDS
  return Math.min(Math.max(1, Math.ceil(seconds)), MAX_RETRY_AFTER_SECONDS)
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null

const stringOrNull = (value: unknown): boolean => value === null || typeof value === 'string'
const numberOrNull = (value: unknown): boolean => value === null || typeof value === 'number'

function isVendor(value: unknown): boolean {
  if (value === null) return true
  if (!isRecord(value) || typeof value.name !== 'string') return false
  return [value.preferredName, value.legalName, value.landingPageUrl].every(stringOrNull)
}

function isProduct(value: unknown): boolean {
  if (value === null) return true
  if (!isRecord(value) || typeof value.name !== 'string') return false
  if (typeof value.commissioningCustomFlow !== 'number' || !numberOrNull(value.deviceTypeId)) {
    return false
  }
  return [
    value.label,
    value.partNumber,
    value.productUrl,
    value.supportUrl,
    value.userManualUrl,
    value.commissioningCustomFlowUrl,
    value.commissioningInstructions,
    value.factoryResetInstructions,
  ].every(stringOrNull)
}

/**
 * Whether a parsed 200 body really is a catalogue answer.
 *
 * Checked by shape at the trust boundary, as `requestTokens` does: a proxy's HTML page or an
 * older server must become `unavailable`, not a device named `undefined`.
 */
export function isCatalogLookup(body: unknown): body is CatalogLookup {
  return (
    isRecord(body) &&
    typeof body.vendorId === 'number' &&
    typeof body.productId === 'number' &&
    SOURCES.includes(body.source) &&
    typeof body.fetchedAt === 'string' &&
    typeof body.stale === 'boolean' &&
    isVendor(body.vendor) &&
    isProduct(body.product)
  )
}

/**
 * The API client.
 *
 * @param baseUrl `/api`, behind the application's own origin
 * @param token the access token getter, as `projectsApi` takes it; with none held, `lookup`
 *   answers `signed-out` without a request
 * @param fetchImpl injected by tests
 */
export function catalogApi(
  baseUrl: string,
  token: () => string | undefined,
  fetchImpl: typeof fetch = fetch,
): CatalogApi {
  const base = baseUrl.replace(/\/+$/, '')

  return {
    async lookup(code: string, signal?: AbortSignal): Promise<LookupOutcome> {
      const held = token()
      if (held === undefined) return { kind: 'signed-out' }

      let response: Response
      try {
        response = await fetchImpl(`${base}/catalog/lookup`, {
          method: 'POST',
          headers: {
            accept: 'application/json',
            'content-type': 'application/json',
            authorization: `Bearer ${held}`,
          },
          body: JSON.stringify({ code }),
          ...(signal === undefined ? {} : { signal }),
        })
      } catch {
        // Offline, a dropped connection, or aborted because the code changed. Not logged: the
        // request carried the code.
        return UNAVAILABLE
      }

      if (response.status === 401) return { kind: 'signed-out' }
      if (response.status === 429) {
        return {
          kind: 'rate-limited',
          retryAfterSeconds: retryAfterSeconds(response.headers.get('retry-after')),
        }
      }
      if (response.status === 400 || response.status === 422) return { kind: 'unusable' }
      if (!response.ok) return UNAVAILABLE

      let body: unknown
      try {
        body = await response.json()
      } catch {
        return UNAVAILABLE
      }
      return isCatalogLookup(body) ? { kind: 'found', lookup: body } : UNAVAILABLE
    },
  }
}

/**
 * Answers test-vendor codes (0xFFF1–0xFFF4) locally, and passes every other code to `api`.
 *
 * A wrapper rather than a branch inside {@link catalogApi}, so it sits in front of everything a
 * lookup goes through (the add form and backfill both take theirs from `composition.catalog()`)
 * and the HTTP client stays a plain HTTP client. In front of the token check too, because the
 * answer *needs* no token or network. That does not mean it is asked for while signed out or
 * offline: both callers gate on signed-in and online before they ask, and that is unchanged.
 *
 * @param api the lookup to fall back to
 * @param now the clock for `fetchedAt`; injected by tests
 */
export function answeringTestVendors(
  api: CatalogApi,
  now: () => Date = () => new Date(),
): CatalogApi {
  return {
    lookup(code: string, signal?: AbortSignal): Promise<LookupOutcome> {
      const local = testVendorAnswer(code, now())
      return local === undefined
        ? api.lookup(code, signal)
        : Promise.resolve({ kind: 'found', lookup: local })
    },
  }
}
