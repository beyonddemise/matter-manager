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
  /** Whether a stored, unexpired entry has this hash. */
  isLive(email: string, hash: string): Promise<boolean>
  /** Removes the entry from the record and from memory, whichever holds it. */
  revoke(email: string, hash: string): Promise<void>
  /** Removes and returns this address's unexpired memory entries, for a record being created. */
  drain(email: string): RefreshEntry[]
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
      const onRecord = await records.hasRefresh(email, hash, now())
      if (onRecord !== undefined) return onRecord
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

    drain(email) {
      const key = userKey(email)
      const entries = live(memory.get(key) ?? [])
      memory.delete(key)
      return entries
    },
  }
}
