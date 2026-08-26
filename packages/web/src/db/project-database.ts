/**
 * The one place in the repository that opens a database.
 *
 * `@matter-manager/data` deliberately imports no PouchDB implementation — it is handed an open
 * database — so this is where the browser build is supplied. Keeping that to a single module
 * means the "which PouchDB build is this?" question has exactly one answer, and a test can
 * hand a view its own repositories without any of this loading.
 *
 * @module
 */

import {
  type LocalCache,
  localCache,
  type ProjectRepositories,
  projectRepositories,
} from '@matter-manager/data'
import PouchDB from 'pouchdb-browser'

/**
 * The local catalogue.
 *
 * There is no project concept until M5, and minting a uuid now would produce a database name
 * nobody could reproduce after clearing storage. The `project_` prefix matches the naming this
 * project uses for real project databases, so M5 replaces a constant rather than a scheme.
 */
export const PROJECT_DATABASE_NAME = 'project_local'

let opened: ProjectRepositories | undefined

/**
 * The repositories for the local catalogue, opening the database on first use.
 *
 * Lazy rather than module-scoped: opening IndexedDB at import time would do it in every test
 * that touches anything in this package, including the ones with no interest in a database.
 * Memoised because a second `new PouchDB(name)` is a second handle on the same store, and the
 * change feeds that M2-6 attaches would then fire twice.
 */
export function projectDatabase(): ProjectRepositories {
  opened ??= projectRepositories(new PouchDB(PROJECT_DATABASE_NAME))
  return opened
}

/**
 * The cache of what the server has told this browser.
 *
 * Deliberately **not** a project database and never given a remote counterpart: it holds the
 * profile now and the project list at M5, which are the only two things in this application
 * that are server-only (ADR 0012). See `data/src/local-cache.ts` for why replicating it would
 * be wrong rather than merely unnecessary.
 */
export const LOCAL_CACHE_DATABASE_NAME = 'mm-local'

let cache: LocalCache | undefined

/**
 * The local cache, opening the database on first use.
 *
 * Memoised for the same reason as {@link projectDatabase}: a second `new PouchDB(name)` is a
 * second handle on the same store.
 */
export function localProfileCache(): LocalCache {
  cache ??= localCache(new PouchDB(LOCAL_CACHE_DATABASE_NAME))
  return cache
}

/**
 * Forgets the memoised handle.
 *
 * Needed because {@link LocalCache.clear} *destroys* the database, and a destroyed PouchDB
 * handle does not come back — a later read through the same object fails rather than finding an
 * empty cache. Sign-out calls both.
 */
export function forgetLocalProfileCache(): void {
  cache = undefined
}

/**
 * Every database this browser holds on behalf of the signed-in user.
 *
 * Listed by **name** rather than derived from the memoised handles, and that is the whole point:
 * a page that never opened the device list has no project handle to destroy, and destroying only
 * what happens to be open would leave every device on disk while the interface said the user had
 * signed out.
 */
const LOCAL_DATABASE_NAMES = [PROJECT_DATABASE_NAME, LOCAL_CACHE_DATABASE_NAME] as const

/** Opens a database purely to destroy it. Opening one that does not exist is harmless. */
async function destroyByName(name: string): Promise<void> {
  await new PouchDB(name).destroy()
}

/**
 * Removes every local database, for signing out.
 *
 * **Only ever called because the user asked.** An expired session must not reach this — see
 * `session.ts`, where the distinction is the substance of the issue.
 *
 * Each database is attempted regardless of the others (`allSettled`, not sequential `await`s):
 * stopping at the first failure would leave the second one intact, which is the "signed out but
 * the data is still here" state that signing out on a shared machine exists to prevent.
 *
 * @param destroy how to remove one database; injected so a test can make it fail
 * @throws {AggregateError} if any database survived, so `signOut` can say "we could not remove
 *   everything" rather than reporting a success the machine does not reflect
 */
export async function removeLocalDatabases(
  destroy: (name: string) => Promise<void> = destroyByName,
): Promise<void> {
  // Before the destroys, and unconditionally. A destroyed PouchDB handle does not come back, so
  // a memoised one that outlived its database fails every later read; and if a destroy fails,
  // the handle may point at a database that is now half gone.
  opened = undefined
  cache = undefined

  const outcomes = await Promise.allSettled(LOCAL_DATABASE_NAMES.map((name) => destroy(name)))
  const failures = outcomes.flatMap((outcome) =>
    outcome.status === 'rejected' ? [outcome.reason] : [],
  )

  if (failures.length > 0) {
    throw new AggregateError(failures, 'Some local data could not be removed from this browser.')
  }
}
