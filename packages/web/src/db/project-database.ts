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
