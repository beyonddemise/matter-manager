/**
 * Where refresh-token hashes live: on the user's record, or in memory when they have none.
 *
 * Most people who sign in never do anything that needs a record (see `users/ensure.ts`), so
 * their refresh hashes are kept in this process. **A restart forgets them**: those users get a
 * 401 at their next refresh and sign in again, keeping their local data. That cost falls only on
 * people who have used nothing that needed the server, which is why it is acceptable (#210).
 *
 * Revocation is deletion: a refresh is honoured only while its hash is found here, so removing
 * an entry (by sign-out, or by an admin editing the record) ends that device's session.
 *
 * @module
 */

import { createHash } from 'node:crypto'
import { userKey } from '../users/key.js'
import type { RefreshEntry, UserRecords } from '../users/records.js'

/** The stored form of a token id. The token itself is never stored. */
export const hashJti = (jti: string): string => createHash('sha256').update(jti).digest('hex')

/** Refresh-token bookkeeping across records and memory. */
export interface RefreshStore {
  /** Stores on the record if there is one, otherwise in memory. */
  remember(email: string, entry: RefreshEntry): Promise<void>
  /** Whether a stored, unexpired entry has this hash, on the record or in memory. */
  isLive(email: string, hash: string): Promise<boolean>
  /** Removes the entry from the record and from memory, whichever holds it. */
  revoke(email: string, hash: string): Promise<void>
  /** This address's unexpired memory entries, left in place, for a record being created. */
  pending(email: string): RefreshEntry[]
  /** Removes these hashes from memory, once the record that now holds them is written. */
  release(email: string, hashes: readonly string[]): void
}

/** Creates a store over `records`, with an empty memory. */
export function refreshStore(records: UserRecords, now: () => number): RefreshStore {
  // Keyed by `userKey`, so case and whitespace cannot split one person's entries.
  const memory = new Map<string, RefreshEntry[]>()
  const live = (entries: readonly RefreshEntry[]) => entries.filter((e) => e.exp > now())

  return {
    async remember(email, entry) {
      if (await records.addRefresh(email, entry)) return
      const key = userKey(email)
      memory.set(key, [...live(memory.get(key) ?? []), entry])
    },

    async isLive(email, hash) {
      if ((await records.hasRefresh(email, hash, now())) === true) return true
      // Memory is consulted even when a record exists. A record can be created by a path that
      // does not move this store's entries (an operator setting a plan), and the spec's promise is that
      // creating a record never signs anybody out. Revocation is unaffected: `revoke` clears
      // both, and `release` empties memory whenever entries move onto a record.
      return live(memory.get(userKey(email)) ?? []).some((e) => e.hash === hash)
    },

    async revoke(email, hash) {
      const key = userKey(email)
      memory.set(
        key,
        (memory.get(key) ?? []).filter((e) => e.hash !== hash),
      )
      await records.removeRefresh(email, hash)
    },

    // Read without removing, and removed only by `release` after the record write succeeded.
    // The earlier drain-then-restore left a window in which `isLive` saw neither copy, and its
    // restore wrote to CouchDB, which is exactly what is down when the restore is needed.
    pending(email) {
      return live(memory.get(userKey(email)) ?? [])
    },

    release(email, hashes) {
      const key = userKey(email)
      const kept = (memory.get(key) ?? []).filter((e) => !hashes.includes(e.hash))
      if (kept.length === 0) memory.delete(key)
      else memory.set(key, kept)
    },
  }
}
