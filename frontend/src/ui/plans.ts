/**
 * The published plan matrix: what the upgrade dialog's comparison shows (#224).
 *
 * `GET /plans` answers the operator-maintained comparison — marketing plan names as keys, each
 * with its labelled values in the operator's row order. It is **source copy, not entitlement
 * data**: values arrive as display text (`"Unlimited*"`, `"Free forever"`) and are shown
 * verbatim, while what an account may *do* keeps coming from the tables in `domain/plan.ts`.
 * The marketing keys need not match the `Plan` enum — `tierOf` connects the two vocabularies.
 *
 * ## The order things are tried, and why
 *
 * The same ladder as the profile (`profile.ts`), for the same reason:
 *
 * 1. **The cache** (`cache:plans`), so the dialog opens offline with the last published matrix.
 * 2. **The server**, in the background. A good answer corrects the cache and the open dialog.
 * 3. **The built-in tables**, when there is neither — a device that never reached a server
 *    publishing the matrix. They go once `/plans` is served in production.
 *
 * @module
 */

import type { LocalCache } from '../data/index.js'

/**
 * The matrix as `GET /plans` answers it: marketing plan keys, in the server's column order, each
 * mapping row labels to display values in the operator's row order.
 */
export type PlanMatrix = Readonly<Record<string, Readonly<Record<string, string | number>>>>

/**
 * Whether a parsed body is a plan matrix. Checked by shape at the trust boundary, as `isProfile`
 * is: a proxy's HTML page, an older server, or a cache written by another build must not render
 * as a comparison. An empty object is refused too — a comparison of no plans is nothing to show,
 * and the fallbacks behind it are.
 */
export function isPlanMatrix(body: unknown): body is PlanMatrix {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) return false
  const plans = Object.values(body)
  if (plans.length === 0) return false
  return plans.every(
    (rows) =>
      typeof rows === 'object' &&
      rows !== null &&
      !Array.isArray(rows) &&
      Object.values(rows).every(
        (value) =>
          typeof value === 'string' || (typeof value === 'number' && Number.isFinite(value)),
      ),
  )
}

/** How the matrix is fetched. Injected so views test without a server. */
export interface PlansApi {
  /** The published matrix, or `undefined` when there is none to be had. */
  read(): Promise<PlanMatrix | undefined>
}

/**
 * The API client. Public — no token, unlike the profile: the comparison is marketing copy shown
 * before anyone signs in.
 *
 * `read` never throws. A 404 (nothing published, or a backend without the route yet), a network
 * failure, a proxy's HTML page and a body of the wrong shape all answer `undefined`, because the
 * caller's next move — the cache, then the built-in tables — is the same for every one of them.
 */
export function plansApi(baseUrl: string, fetchImpl: typeof fetch = fetch): PlansApi {
  const base = baseUrl.replace(/\/+$/, '')

  return {
    async read(): Promise<PlanMatrix | undefined> {
      let body: unknown
      try {
        const response = await fetchImpl(`${base}/plans`, {
          headers: { accept: 'application/json' },
        })
        if (!response.ok) return undefined
        body = await response.json()
      } catch {
        return undefined
      }
      return isPlanMatrix(body) ? body : undefined
    },
  }
}

/**
 * Loads the matrix, preferring the cache and correcting it from the server, the way
 * `resolveProfileLocale` loads the profile.
 *
 * Never throws. `onMatrix` fires up to twice — the cached answer before the network is asked,
 * so a dialog opens with it at once, and the server's answer when it differs. The returned
 * promise settles only when the fetch and the cache write are done: a caller that holds it can
 * keep overlapping loads single-flight, so a close-and-reopen cannot race two fetches whose
 * older answer would overwrite the newer one in the cache and on screen. The matrix is public
 * and the same for every account, so unlike the profile nothing here needs a sign-out guard: a
 * late answer is never somebody else's data, at worst a moment stale.
 *
 * @param onMatrix called with what the dialog should show, cached then corrected; never called
 *   with the same answer twice, and not at all when neither cache nor server has one.
 */
export async function resolvePlanMatrix(
  api: PlansApi,
  cache: LocalCache,
  onMatrix: (matrix: PlanMatrix) => void,
  now: () => string = () => new Date().toISOString(),
): Promise<void> {
  let cached: PlanMatrix | undefined
  try {
    const stored = await cache.readPlanMatrix()
    // Guarded again on the way out: the document is whatever build wrote it last.
    cached = stored !== undefined && isPlanMatrix(stored.matrix) ? stored.matrix : undefined
  } catch {
    // An unreadable cache is not a reason to be unusable; the server is asked below.
    cached = undefined
  }
  if (cached !== undefined) onMatrix(cached)

  const fresh = await api.read()
  if (fresh === undefined) return

  await cache.writePlanMatrix({ matrix: fresh, fetchedAt: now() }).catch(() => {
    // A cache that refuses the write still leaves this session's dialog correct.
  })
  if (JSON.stringify(fresh) !== JSON.stringify(cached)) onMatrix(fresh)
}
