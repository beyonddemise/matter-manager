/**
 * The lookup algorithm: cache first, the DCL when the cache is absent or old, and the old entry
 * when the DCL cannot be reached.
 *
 * Separate from the route so the algorithm can be tested without HTTP, and from `policy.ts`
 * because this is the part with I/O in it.
 *
 * **Degrades rather than fails on CouchDB.** The cache is an optimisation: a CouchDB read that
 * fails is treated as "nothing cached", and a write that fails is logged and skipped, so a
 * catalogue lookup still answers from the DCL while the database is having a bad minute. The
 * failure goes to the log, where somebody can act on it.
 *
 * @module
 */

import { type DclClient, DclUnavailable } from './dcl.js'
import type { CodeIds } from './decode.js'
import { isFresh } from './policy.js'
import {
  type CatalogEntry,
  type CatalogStore,
  type ModelEntry,
  modelEntryId,
  type VendorEntry,
  vendorEntryId,
  withoutCreator,
} from './store.js'

/** What the lookup needs. */
export interface LookupDependencies {
  readonly store: CatalogStore
  readonly dcl: DclClient
  /** The clock, for freshness and for `fetchedAt` on what is written. */
  readonly now: () => Date
  /**
   * Where a degraded step is reported. The route passes `request.log.warn`; nothing passed here
   * ever contains the setup code, because nothing here ever sees it.
   */
  readonly warn: (context: Record<string, unknown>, message: string) => void
}

/** Both entries, and whether either was served past its freshness because the DCL failed. */
export interface LookupResult {
  readonly vendor: VendorEntry
  readonly model: ModelEntry
  readonly stale: boolean
}

/** One entry resolved, or `undefined` when the DCL failed and nothing was cached. */
type Resolved<T> = { readonly entry: T; readonly stale: boolean } | undefined

/**
 * Resolves the vendor and model entries for these IDs.
 *
 * The two halves are independent and run in parallel. Either one unanswerable — the DCL down and
 * nothing cached — makes the whole lookup unanswerable, and the route says 503.
 *
 * @returns `undefined` when the DCL could not be reached and nothing usable was cached.
 */
export async function lookupEntries(
  ids: CodeIds,
  deps: LookupDependencies,
): Promise<LookupResult | undefined> {
  const { vendorId: vid, productId: pid } = ids
  const [vendor, model] = await Promise.all([
    resolve<VendorEntry>(
      deps,
      { vid },
      () => deps.store.readVendor(vid),
      async (fetchedAt) => {
        const record = await deps.dcl.vendor(vid)
        const base = { _id: vendorEntryId(vid), type: 'vendor', vid, fetchedAt } as const
        return record === 'missing'
          ? { ...base, status: 'missing', network: deps.dcl.network }
          : { ...base, status: 'found', network: deps.dcl.network, dcl: withoutCreator(record) }
      },
    ),
    resolve<ModelEntry>(
      deps,
      { vid, pid },
      () => deps.store.readModel(vid, pid),
      async (fetchedAt) => {
        const record = await deps.dcl.model(vid, pid)
        const base = { _id: modelEntryId(vid, pid), type: 'model', vid, pid, fetchedAt } as const
        return record === 'missing'
          ? { ...base, status: 'missing', network: deps.dcl.network }
          : { ...base, status: 'found', network: deps.dcl.network, dcl: withoutCreator(record) }
      },
    ),
  ])

  if (vendor === undefined || model === undefined) return undefined
  return { vendor: vendor.entry, model: model.entry, stale: vendor.stale || model.stale }
}

/**
 * One half of the lookup: cached if fresh, else fetched and stored, else cached and stale.
 *
 * @param context the IDs, for the log line when something degrades.
 * @param read the cached entry, if any.
 * @param fetch the entry built from a DCL answer; throws {@link DclUnavailable} when there is none.
 */
async function resolve<T extends CatalogEntry>(
  deps: LookupDependencies,
  context: Record<string, number>,
  read: () => Promise<T | undefined>,
  fetch: (fetchedAt: string) => Promise<T>,
): Promise<Resolved<T>> {
  const now = deps.now()
  const cached = await read().catch((error: unknown) => {
    deps.warn({ ...context, err: error }, 'catalogue cache unreadable; asking the DCL')
    return undefined
  })
  if (cached !== undefined && isFresh(cached, now)) return { entry: cached, stale: false }

  let fetched: T
  try {
    fetched = await fetch(now.toISOString())
  } catch (error) {
    // Only an outage is survivable. Anything else is a bug in this module, and serving a stale
    // entry would hide it.
    if (!(error instanceof DclUnavailable)) throw error
    deps.warn({ ...context, err: error }, 'DCL unavailable')
    return cached === undefined ? undefined : { entry: cached, stale: true }
  }

  // Replacing an old entry needs its revision; a first write has none to carry.
  const entry = cached?._rev === undefined ? fetched : { ...fetched, _rev: cached._rev }
  await deps.store.write(entry).catch((error: unknown) => {
    deps.warn({ ...context, err: error }, 'catalogue cache unwritable; answering anyway')
  })
  return { entry, stale: false }
}
