/**
 * The one way a user record comes into existence.
 *
 * Records are created on demand (the spec, "Records are created on demand"): accepting an
 * invitation, accepting a transfer, `PATCH /profile`. Each of those calls this, so moving the
 * in-memory refresh entries onto the new record cannot be forgotten by one of them. If it were,
 * that path would sign its user out at their next refresh. (`PUT /customer` creates a record by
 * address through `setPlan` and does not move entries; `isLive` consults memory too, so that signs
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
    const pending = refresh.pending(seed.email)
    // Errors propagate untouched and memory is untouched until the write has succeeded: the
    // entries stay live throughout, so a failed ensure signs nobody out and a concurrent
    // `isLive` always finds the hash in at least one place.
    const record = await records.ensure(seed, pending)
    refresh.release(
      seed.email,
      pending.map((e) => e.hash),
    )
    return record
  }
}
