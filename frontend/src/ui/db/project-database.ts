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
  forgetCiphertextScan,
  isLocalOnlyDatabase,
  type LocalCache,
  type LocalProjectEntry,
  localCache,
  type ProjectRepositories,
  projectRepositories,
} from '../../data/index.js'
import { PROJECT_KEY_PREFIX } from '../../domain/documents/keys.js'
import { documentTypeOf } from '../../domain/index.js'
import { PROJECT_CHANGED } from '../current-project.js'
import { coordinateWrites } from './db-lock.js'
import { memoiseKeyState, resolveKeyState, unlockProject } from './keyring.js'

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
  /** Drops the memoised key state, so the next repository operation resolves it afresh. */
  readonly forgetKeyState: () => void
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
 * The repositories for a named database, whichever project is currently open.
 *
 * Shares the memo with {@link projectDatabase}, so opening a project here and then switching to
 * it does not open it twice - two handles on one store means every change feed fires twice.
 */
export function openProject(dbName: string): ProjectRepositories {
  return openHandle(dbName).repositories
}

/**
 * The memoised handle for a database, opening it on first use.
 *
 * Opened straight into the cross-tab write coordination of #220 (`db-lock.ts`): every write
 * through the handle — the repositories built below included, and replication pulling into it —
 * holds the database's shared Web Lock, so a destroy in another tab cannot race a fresh open;
 * the first write simply waits until the destroy is over, and then fails where its caller sees
 * it rather than landing in a database that was verified as fully transferred.
 */
function openHandle(dbName: string): OpenedProject {
  const existing = opened.get(dbName)
  if (existing !== undefined) return existing

  const database = coordinateWrites(dbName, new PouchDB(dbName))

  // The project's key state (#302), memoised beside the handle for the handle's lifetime —
  // resolved once per opened database, not per read. Lazily, on the first repository operation
  // rather than here: opening is synchronous and, more importantly, project creation opens the
  // database *before* it writes the key documents, and a state resolved at that instant would
  // memoise "plaintext" for a project that is about to be encrypted. `memoiseKeyState` also
  // forgets a *rejected* resolution, so one IndexedDB hiccup fails one operation, not the
  // handle. The provider form is the recovery seam: {@link refreshProjectKeyState} drops the
  // memo, and the repositories every view already holds pick up the new state on their next
  // operation.
  //
  // A resolution that answers *locked* is also where escrow recovery (#304) starts: once per
  // resolution, behind the read that found it, so the read answers at once and the views are
  // told when the key has arrived.
  const keyState = memoiseKeyState(async () => {
    const state = await resolveKeyState(database)
    if (state?.kind === 'locked') {
      lockedProjects.add(dbName)
      recoverLockedProject(dbName, database)
    } else {
      lockedProjects.delete(dbName)
    }
    return state
  })

  const handle: OpenedProject = {
    database,
    repositories: projectRepositories(database, undefined, keyState.provider),
    forgetKeyState: keyState.refresh,
  }
  opened.set(dbName, handle)
  return handle
}

/**
 * Drops a project's memoised key state when an inbound batch delivered wrap documents.
 *
 * Replication is how the `key:*` documents reach a database that resolved its state before they
 * existed — a copy still downloading, or this device's missing wrap arriving via escrow — and a
 * memo from before they landed is plaintext-or-locked about a database that can now do better.
 * Filtered on the inbound ids rather than refreshing on every pull, so the common case (device
 * edits arriving all day) never re-resolves anything. Wired to both inbound paths in
 * `composition.ts`; the next repository operation picks the fresh state up.
 *
 * A batch carrying devices also drops the database's cached *negative* ciphertext scan (#336,
 * `forgetCiphertextScan`): those devices may be ciphertext whose wraps are still to come, and the
 * next keyless write must find that out itself rather than trust a view to have read them first.
 */
export function refreshKeyStateOnInboundKeys(dbName: string, docIds: readonly string[]): void {
  if (docIds.some((id) => id.startsWith(PROJECT_KEY_PREFIX))) refreshProjectKeyState(dbName)
  if (docIds.some((id) => documentTypeOf(id) === 'device')) {
    const handle = opened.get(dbName)
    if (handle !== undefined) forgetCiphertextScan(handle.database)
  }
}

/**
 * Drops a project's memoised key state, so the next read or write resolves it again.
 *
 * The re-resolution half of the #302 seam, for whoever changes what resolution would find: F7's
 * escrow recovery after the missing wrap arrives, and any pull that delivers `key:*` documents
 * into a database that resolved before they existed. A no-op for a database that is not open.
 */
export function refreshProjectKeyState(dbName: string): void {
  opened.get(dbName)?.forgetKeyState()
}

/**
 * How a locked project gets its key: escrow recovery (`recoverProjectKey`, #304), with the
 * online and signed-in checks and the pull bound in. Answers whether the project now unlocks.
 */
export type KeyRecovery = (dbName: string, database: PouchDB.Database) => Promise<boolean>

/** The registered recovery; `undefined` until `main.ts` registers one, and in most tests. */
let keyRecovery: KeyRecovery | undefined
/** Databases whose last resolution answered locked — what the next open retries. */
const lockedProjects = new Set<string>()
/** Databases with a recovery in flight, so overlapping triggers ask the server once. */
const recovering = new Set<string>()

/**
 * Registers how locked projects are recovered.
 *
 * A registration rather than an import: the recovery needs the API base, the token and the
 * remote CouchDB, which `composition.ts` assembles — and that module already imports this one.
 *
 * @param recovery the recovery, or `undefined` to turn it off (tests)
 */
export function useKeyRecovery(recovery: KeyRecovery | undefined): void {
  keyRecovery = recovery
}

/**
 * Runs the registered recovery for a locked project, unless one is already running.
 *
 * Fire-and-forget by design: the read that found the project locked has already answered, and
 * the locked state is a complete, safe answer on its own. On success the memoised key state is
 * dropped and, when this is the project on screen, {@link PROJECT_CHANGED} tells every view to
 * re-read — the same repositories then decrypt, so the recovery is invisible. On a refusal or
 * a failure nothing happens: the project stays locked until the next open (no retry loop).
 */
function recoverLockedProject(dbName: string, database: PouchDB.Database): void {
  const recover = keyRecovery
  if (recover === undefined || recovering.has(dbName)) return
  recovering.add(dbName)
  void recover(dbName, database)
    .catch((error: unknown) => {
      console.warn('The project key could not be recovered; the next open retries.', error)
      return false
    })
    // A recovery that failed may still have delivered the wrap: a one-shot pull whose first
    // batch carried `key:<kid>` and whose next batch failed rejects, and its ids go with it
    // (#304 review). So a failure asks the database itself whether the project now unlocks,
    // rather than trusting the outcome to have seen every batch.
    .then(async (recovered) => recovered || (await unlocksNow(database)))
    .then((unlocked) => {
      // A handle forgotten meanwhile (the copy was removed) has nothing left to refresh.
      if (!unlocked || opened.get(dbName)?.database !== database) return
      refreshProjectKeyState(dbName)
      if (dbName === currentName) window.dispatchEvent(new CustomEvent(PROJECT_CHANGED))
    })
    .finally(() => {
      recovering.delete(dbName)
    })
}

/** Whether this device's wrap is in the database and opens; a broken one answers `false`. */
async function unlocksNow(database: PouchDB.Database): Promise<boolean> {
  try {
    return (await unlockProject(database)) !== null
  } catch {
    return false
  }
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
  lockedProjects.delete(dbName)
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
  const switched = dbName !== currentName
  currentName = dbName
  currentEditable = editable
  window.dispatchEvent(new CustomEvent(PROJECT_CHANGED))
  // Opening a project already known to be locked is the next recovery attempt (#304): its key
  // state is memoised, so no fresh resolution would start one.
  if (switched && lockedProjects.has(dbName)) recoverLockedProject(dbName, rawDatabase(dbName))
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
  const alsoOpened = [...opened.keys()].filter((name) => includeLocal || !isLocalOnlyDatabase(name))

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
  // A server-named database is a downloaded copy of the account's server project: it is the
  // previous user's data and always goes. A local-only one (the legacy `project_local`
  // included) is the "local catalogue" of #55, which predates accounts and so goes only when
  // asked. Judged by name rather than by `projectId`: a promotion that stopped half way has an
  // id on a database whose data has not left this device yet. Such an entry is only *kept* if
  // it can be re-listed afterwards (below), because the index lives in `mm-local`, which is
  // always destroyed.
  const indexedGoing = indexed.filter((entry) => includeLocal || !isLocalOnlyDatabase(entry.dbName))
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
  lockedProjects.clear()
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
