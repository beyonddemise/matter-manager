import PouchDB from 'pouchdb-browser'
import {
  type KeyState,
  type ProjectRepositories,
  projectRepositories,
} from '../../../src/data/index.js'
import { generateDek } from '../../../src/domain/crypto/envelope.js'
import { fieldCipher } from '../../../src/ui/db/keyring.js'

let counter = 0

/** One encrypted database, seen two ways: by a device holding its key, and by one without. */
export interface LockedTestDatabase {
  /** Repositories with the DEK in hand: what wrote the ciphertext. */
  readonly unlocked: ProjectRepositories
  /** Repositories over the same store in the locked state (#302): reads omit, writes refuse. */
  readonly locked: ProjectRepositories
  /**
   * Repositories that start locked and unlock on {@link unlock}: the key arriving while a view
   * still holds what it read under the lock (the F7 finding folded into #303).
   */
  readonly unlockable: ProjectRepositories
  /** Hands {@link unlockable} the DEK, as escrow recovery does. */
  unlock(): void
  /** The store itself, for asserting what is on disk rather than what a repository answers. */
  readonly raw: PouchDB.Database
  destroy(): Promise<void>
}

/**
 * A fresh IndexedDB database whose device documents are encrypted under a DEK, with a second
 * set of repositories that sees it locked.
 *
 * Locked the way the application is locked: the same `projectRepositories` wiring, handed the
 * `{ kind: 'locked' }` state through a provider as `ui/db/project-database.ts` hands it. Nothing
 * here fakes a locked read's shape, so a view test meets exactly what F5's seam answers.
 */
export async function lockedDatabase(): Promise<LockedTestDatabase> {
  counter += 1
  const raw = new PouchDB(`matter-manager-locked-test-${counter}`)
  const cipher = fieldCipher(await generateDek())
  let state: KeyState = { kind: 'locked' }
  return {
    unlockable: projectRepositories(raw, undefined, () => state),
    unlock: () => {
      state = { kind: 'unlocked', cipher }
    },
    unlocked: projectRepositories(raw, undefined, { kind: 'unlocked', cipher }),
    locked: projectRepositories(raw, undefined, () => ({ kind: 'locked' })),
    raw,
    destroy: async () => {
      await raw.destroy()
    },
  }
}
