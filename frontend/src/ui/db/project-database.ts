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

import PouchDB from 'pouchdb-browser'
import {
  type LocalCache,
  type LocalProjectEntry,
  localCache,
  type ProjectRepositories,
  projectRepositories,
} from '../../data/index.js'
import { PROJECT_CHANGED } from '../current-project.js'

/**
 * The local catalogue.
 *
 * There is no project concept until M5, and minting a uuid now would produce a database name
 * nobody could reproduce after clearing storage. The `project_` prefix matches the naming this
 * project uses for real project databases, so M5 replaces a constant rather than a scheme.
 */
export const PROJECT_DATABASE_NAME = 'project_local'

/** A database and the repositories built over it; one handle serves both. */
interface OpenedProject {
  readonly database: PouchDB.Database
  readonly repositories: ProjectRepositories
}

/**
 * One handle per database, with the repositories over it, kept for as long as the page lives.
 *
 * Keyed by name rather than a single handle, because #55 lets the reader move between projects
 * and switching back should not reopen what is already open. Memoised at all because a second
 * `new PouchDB(name)` is a second handle on the same store, and the change feeds M2-6 attaches
 * would then fire twice.
 */
const opened = new Map<string, OpenedProject>()

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
  return openProject(currentName)
}

/**
 * The catalogue that lives only on this device, whichever project is currently open.
 *
 * Named explicitly rather than reached through {@link projectDatabase}, because the one caller
 * — moving its contents into a project (#55) — needs *both* at once, and asking for "the
 * current one" would give it the same database twice.
 */
export function localCatalogue(): ProjectRepositories {
  return openProject(PROJECT_DATABASE_NAME)
}

/**
 * The repositories for a named database, whichever project is currently open.
 *
 * Shares the memo with {@link projectDatabase}, so opening a project here and then switching to
 * it does not open it twice - two handles on one store means every change feed fires twice.
 */
export function openProject(dbName: string): ProjectRepositories {
  return openHandle(dbName).repositories
}

/** The memoised handle for a database, opening it on first use. */
function openHandle(dbName: string): OpenedProject {
  const existing = opened.get(dbName)
  if (existing !== undefined) return existing

  const database = new PouchDB(dbName)
  const handle = { database, repositories: projectRepositories(database) }
  opened.set(dbName, handle)
  return handle
}

/**
 * The raw PouchDB for a project database, for what the repositories do not model: replication,
 * and the `project` document (which is not a device or a room).
 *
 * The *same* handle {@link openProject} uses, not a second `new PouchDB(name)`: two handles on
 * one store would fire every change feed twice. Callers must not destroy it directly - go
 * through `destroyLocalProject`, which also forgets it.
 */
export function rawDatabase(dbName: string): PouchDB.Database {
  return openHandle(dbName).database
}

/**
 * Drops the memoised handle for a database that has been (or is being) destroyed.
 *
 * A destroyed PouchDB handle does not come back, so keeping it would fail every later read of a
 * database that was since recreated under the same name.
 */
export function forgetProject(dbName: string): void {
  opened.delete(dbName)
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
let localDb: PouchDB.Database | undefined

/**
 * The raw `mm-local` database, opening it on first use.
 *
 * Exposed for the refresh-token store, which keeps a `_local/` document beside the cache's
 * own. Shared with {@link localProfileCache} so there is a single handle on the store.
 */
export function localDatabase(): PouchDB.Database {
  localDb ??= new PouchDB(LOCAL_CACHE_DATABASE_NAME)
  return localDb
}

/**
 * The local cache, opening the database on first use.
 *
 * Memoised for the same reason as {@link projectDatabase}: a second `new PouchDB(name)` is a
 * second handle on the same store.
 */
export function localProfileCache(): LocalCache {
  cache ??= localCache(localDatabase())
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
  localDb = undefined
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
  // Local-only names (`project_local`, `project_local_<uuid>`) are filtered out unless the reader
  // asked: this list exists for when the cache cannot be read, and in that state the index that
  // would say "keep these" is unavailable, so the name itself has to.
  const includeLocal = options.includeLocalCatalogue === true
  const isLocalOnly = (name: string) =>
    name === PROJECT_DATABASE_NAME || name.startsWith('project_local_')
  const alsoOpened = [...opened.keys()].filter((name) => includeLocal || !isLocalOnly(name))

  let replicated: readonly string[] = []
  let indexed: readonly LocalProjectEntry[] = []
  try {
    const profileCache = localProfileCache()
    replicated = (await profileCache.readProjects()).map((project) => project.dbName)
    indexed = await profileCache.readLocalProjects()
  } catch {
    // An unreadable cache means the fixed names below are all that can be removed. Reporting
    // nothing removable would be worse: the two that are certain would survive as well.
  }

  // What the index lists splits in two, and the sign-out control's checkbox decides one half.
  // A database with a `projectId` is a downloaded copy of the account's server project: it is
  // the previous user's data and always goes. One without is a local-only project (the legacy
  // `project_local` included) - the "local catalogue" of #55, which predates accounts and so
  // goes only when asked. Such an entry is only *kept* if it can be re-listed afterwards
  // (below), because the index lives in `mm-local`, which is always destroyed.
  const indexedGoing = indexed.filter((entry) => includeLocal || entry.projectId !== undefined)
  const indexedKept = indexed.filter((entry) => !indexedGoing.includes(entry))

  // The local catalogue is only included when the reader asked. It predates accounts and holds
  // whatever was recorded before signing in, so signing out of an unrelated account must not
  // take it - but on a shared machine somebody may well want it gone, which is why the control
  // asks rather than this deciding (#55).
  const names = [
    ...new Set([
      ...ACCOUNT_DATABASE_NAMES,
      ...replicated,
      ...indexedGoing.map((entry) => entry.dbName),
      ...alsoOpened,
      ...(includeLocal ? [PROJECT_DATABASE_NAME] : []),
    ]),
  ]

  // Before the destroys, and unconditionally. A destroyed PouchDB handle does not come back, so
  // a memoised one that outlived its database fails every later read; and if a destroy fails,
  // the handle may point at a database that is now half gone.
  opened.clear()
  forgetLocalProfileCache()

  const outcomes = await Promise.allSettled(names.map((name) => destroy(name)))
  const failures = outcomes.flatMap((outcome) =>
    outcome.status === 'rejected' ? [outcome.reason] : [],
  )

  // Re-list the local-only projects that were deliberately kept, in the fresh `mm-local` the
  // destroy above leaves behind. Without this they would stay on disk with nothing naming them:
  // unreachable, and invisible to the next sign-out that does ask for them to go.
  if (indexedKept.length > 0) {
    try {
      const fresh = localProfileCache()
      for (const entry of indexedKept) await fresh.addLocalProject(entry)
    } catch (error) {
      failures.push(error)
    }
  }

  if (failures.length > 0) {
    throw new AggregateError(failures, 'Some local data could not be removed from this browser.')
  }
}
