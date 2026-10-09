/**
 * The `matter_catalog` database: what the DCL said about each vendor and model, and when.
 *
 * A cache, not a source of truth — every document can be fetched again from the DCL — so it is
 * created on the first lookup rather than at startup. It is **admin-only** like `matter_manager`:
 * nothing in it is secret, but a browser has no reason to read it, and a database the browser
 * cannot reach is one nobody has to reason about (SECURITY-MODEL.md).
 *
 * Each document keeps the DCL record **raw**, minus `creator`, so a field the app starts using
 * later needs no re-fetch. IDs are decimal, as the DCL's own paths are.
 *
 * @module
 */

import { type CouchClient, CouchError, type Revision } from '../couch/client.js'
import { installDesign, once } from '../couch/design.js'
import type { DclModel, DclNetwork, DclVendor } from './dcl.js'

/** The database the catalogue lives in. */
export const CATALOG_DB = 'matter_catalog'
/** The design document holding {@link BY_FETCHED_VIEW}. */
export const CATALOG_DESIGN = 'catalog'
/** Entries by `fetchedAt`, for the future "refresh all" (issue 6). Costs nothing until then. */
export const BY_FETCHED_VIEW = 'by_fetched'

const BY_FETCHED_MAP = `function (doc) {
  if (doc.fetchedAt) {
    emit(doc.fetchedAt, null)
  }
}`

/** Whether the DCL had the record when it was asked. */
export type EntryStatus = 'found' | 'missing'

/** Common to vendor and model entries. */
interface EntryBase extends Revision {
  readonly status: EntryStatus
  /** ISO 8601, when the DCL was asked. Freshness is measured from here. */
  readonly fetchedAt: string
  readonly network: DclNetwork
}

/** `vendor:{vid}`. `dcl` is present exactly when `status` is `found`. */
export interface VendorEntry extends EntryBase {
  readonly type: 'vendor'
  readonly vid: number
  readonly dcl?: DclVendor
}

/** `model:{vid}:{pid}`. `dcl` is present exactly when `status` is `found`. */
export interface ModelEntry extends EntryBase {
  readonly type: 'model'
  readonly vid: number
  readonly pid: number
  readonly dcl?: DclModel
}

/** Either kind of entry. */
export type CatalogEntry = VendorEntry | ModelEntry

/** The document ID of a vendor entry. Decimal, like the DCL path. */
export const vendorEntryId = (vid: number): string => `vendor:${vid}`
/** The document ID of a model entry. */
export const modelEntryId = (vid: number, pid: number): string => `model:${vid}:${pid}`

/**
 * The DCL record without `creator`.
 *
 * `creator` is the ledger account that wrote the record. It is not about the product, nothing
 * here reads it, and keeping it would put a third party's account identifiers into our backups.
 *
 * Returns `T` rather than `Omit<T, 'creator'>`: the record types carry an index signature, and
 * `Omit` over one erases every named field along with the one it removes.
 */
export function withoutCreator<T extends { readonly [field: string]: unknown }>(record: T): T {
  const { creator: _creator, ...rest } = record
  return rest as T
}

const setup = once(async (couch: CouchClient) => {
  await couch.createDb(CATALOG_DB)
  // Immediately after creation, before the view, for the reason `users/database.ts` gives: until
  // it lands, the database is open to every account in the deployment.
  await couch.putSecurity(CATALOG_DB, {
    admins: { names: [], roles: ['_admin'] },
    members: { names: [], roles: ['_admin'] },
  })
  await installDesign(couch, CATALOG_DB, `_design/${CATALOG_DESIGN}`, {
    [BY_FETCHED_VIEW]: { map: BY_FETCHED_MAP },
  })
})

/** Creates `matter_catalog` if needed, locks it down, and installs its view. Once per process. */
export function ensureCatalogDatabase(couch: CouchClient): Promise<void> {
  return setup.ensure(couch)
}

/** Forgets that setup ran. For tests that use a fresh fake CouchDB each time. */
export function forgetCatalogDatabase(): void {
  setup.forget()
}

/** Reading and writing entries. Every call ensures the database first. */
export interface CatalogStore {
  readVendor(vid: number): Promise<VendorEntry | undefined>
  readModel(vid: number, pid: number): Promise<ModelEntry | undefined>
  /**
   * Stores an entry; carry the `_rev` of the entry it replaces.
   *
   * A 409 is ignored: another request stored the same answer first, which is the ordinary race
   * of two people adding the same product at once. Anything else throws.
   */
  write(entry: CatalogEntry): Promise<void>
}

/** The store, over the service's CouchDB client. */
export function catalogStore(couch: CouchClient): CatalogStore {
  return {
    async readVendor(vid) {
      await ensureCatalogDatabase(couch)
      return couch.getDoc<VendorEntry>(CATALOG_DB, vendorEntryId(vid))
    },

    async readModel(vid, pid) {
      await ensureCatalogDatabase(couch)
      return couch.getDoc<ModelEntry>(CATALOG_DB, modelEntryId(vid, pid))
    },

    async write(entry) {
      await ensureCatalogDatabase(couch)
      try {
        await couch.putDoc(CATALOG_DB, entry)
      } catch (error) {
        // The other writer fetched the same record from the same ledger within the same few
        // seconds. Its copy is as good as ours, and the response uses what we fetched anyway.
        if (error instanceof CouchError && error.status === 409) return
        throw error
      }
    },
  }
}
