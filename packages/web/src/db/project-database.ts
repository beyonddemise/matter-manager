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
import { PROJECT_CHANGED } from '../current-project.js'

/**
 * The local catalogue.
 *
 * There is no project concept until M5, and minting a uuid now would produce a database name
 * nobody could reproduce after clearing storage. The `project_` prefix matches the naming this
 * project uses for real project databases, so M5 replaces a constant rather than a scheme.
 */
export const PROJECT_DATABASE_NAME = 'project_local'

/**
 * One set of repositories per database, kept for as long as the page lives.
 *
 * Keyed by name rather than a single handle, because #55 lets the reader move between projects
 * and switching back should not reopen what is already open. Memoised at all because a second
 * `new PouchDB(name)` is a second handle on the same store, and the change feeds M2-6 attaches
 * would then fire twice.
 */
const opened = new Map<string, ProjectRepositories>()

/** Which database the views are reading. Changed only through {@link useProjectDatabase}. */
let currentName: string = PROJECT_DATABASE_NAME

/**
 * Whether the open project may be written to.
 *
 * Ambient, like the database itself, and for the same reason: the views that render editing
 * controls are created by the router rather than by anything holding a project, so threading a
 * role through them would mean every view taking a property it does not otherwise need.
 *
 * `true` by default, which is the local catalogue - always the reader's own.
 */
let currentEditable = true

/**
 * The repositories for the project currently open.
 *
 * Lazy rather than module-scoped: opening IndexedDB at import time would do it in every test
 * that touches anything in this package, including the ones with no interest in a database.
 */
export function projectDatabase(): ProjectRepositories {
  const existing = opened.get(currentName)
  if (existing !== undefined) return existing

  const repositories = projectRepositories(new PouchDB(currentName))
  opened.set(currentName, repositories)
  return repositories
}

/** Which database {@link projectDatabase} will open. Exported so a test can read it back. */
export function currentProjectDatabaseName(): string {
  return currentName
}

/**
 * Points the views at another project, and says so.
 *
 * The event is the load-bearing half. Each view resolves its repositories once and holds them
 * in a field - re-resolving on every render would open a second handle and double every change
 * feed - so a switch that only changed this variable would be invisible until something
 * happened to recreate the view.
 *
 * A no-op when the name is unchanged, so a list that re-reports the same project does not make
 * every view throw away its data and read it again.
 */
export function useProjectDatabase(dbName: string, editable = true): void {
  if (dbName === currentName && editable === currentEditable) return
  currentName = dbName
  currentEditable = editable
  window.dispatchEvent(new CustomEvent(PROJECT_CHANGED))
}

/**
 * Whether the open project may be edited.
 *
 * Read by the views that render editing controls, which **remove** them rather than disabling
 * them: a disabled button is a promise that the thing is possible and the reader is doing it
 * wrong, and on a project somebody may only read, neither is true (#55).
 */
export function projectIsEditable(): boolean {
  return currentEditable
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
const ACCOUNT_DATABASE_NAMES = [LOCAL_CACHE_DATABASE_NAME] as const

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
  options: { readonly includeLocalCatalogue?: boolean } = {},
  destroy: (name: string) => Promise<void> = destroyByName,
): Promise<void> {
  // The replicated projects, read before anything is destroyed. #120 gave this browser a
  // database per project the account can see, and nothing removed them - so signing out left
  // every device of the previous user on a shared machine, which is the one thing signing out
  // exists to prevent.
  //
  // Taken from the cache rather than by enumerating IndexedDB: `indexedDB.databases()` is not
  // in Firefox before 126 and this application supports it, and the cache is the record of what
  // this browser actually replicated.
  // What this session actually opened, which is the half the cache cannot lose. Taken *first*:
  // if the cache read below fails, `replicated` is empty, and a database this page has been
  // replicating into all along would survive the sign-out - silently, on a shared machine.
  const alsoOpened = [...opened.keys()].filter((name) => name !== PROJECT_DATABASE_NAME)

  let replicated: readonly string[] = []
  try {
    replicated = (await localProfileCache().readProjects()).map((project) => project.dbName)
  } catch {
    // An unreadable cache means the fixed names below are all that can be removed. Reporting
    // nothing removable would be worse: the two that are certain would survive as well.
  }

  // The local catalogue is only included when the reader asked. It predates accounts and holds
  // whatever was recorded before signing in, so signing out of an unrelated account must not
  // take it - but on a shared machine somebody may well want it gone, which is why the control
  // asks rather than this deciding (#55).
  const names = [
    ...new Set([
      ...ACCOUNT_DATABASE_NAMES,
      ...replicated,
      ...alsoOpened,
      ...(options.includeLocalCatalogue === true ? [PROJECT_DATABASE_NAME] : []),
    ]),
  ]

  // Before the destroys, and unconditionally. A destroyed PouchDB handle does not come back, so
  // a memoised one that outlived its database fails every later read; and if a destroy fails,
  // the handle may point at a database that is now half gone.
  opened.clear()
  cache = undefined

  const outcomes = await Promise.allSettled(names.map((name) => destroy(name)))
  const failures = outcomes.flatMap((outcome) =>
    outcome.status === 'rejected' ? [outcome.reason] : [],
  )

  if (failures.length > 0) {
    throw new AggregateError(failures, 'Some local data could not be removed from this browser.')
  }
}
