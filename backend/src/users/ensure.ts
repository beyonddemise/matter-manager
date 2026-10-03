/**
 * The one way a user record comes into existence.
 *
 * Records are created on demand (the spec, "Records are created on demand"): accepting an
 * invitation, accepting a transfer, `PATCH /profile`. Each of those calls this, so moving the
 * in-memory refresh entries onto the new record cannot be forgotten by one of them. If it were,
 * that path would sign its user out at their next refresh. (`PUT /customer` creates a record by
 * address through `setPlan` and does not drain; `isLive` consults memory too, so that signs
 * nobody out.)
 *
 * @module
 */

import type { RefreshStore } from '../auth/refresh-store.js'
import type { Seed, UserRecord, UserRecords } from './records.js'

/** Creates or completes the record for a signed-in person. */
export type EnsureRecord = (seed: Seed) => Promise<UserRecord>

/** Binds the record store and the refresh store into an {@link EnsureRecord}. */
export function recordEnsurer(records: UserRecords, refresh: RefreshStore): EnsureRecord {
  return async (seed) => {
    const pending = refresh.drain(seed.email)
    try {
      return await records.ensure(seed, pending)
    } catch (error) {
      // Put them back. Losing them would sign the user out for a failure that was not theirs.
      for (const entry of pending) await refresh.remember(seed.email, entry)
      throw error
    }
  }
}
