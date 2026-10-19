/**
 * Projects that live only on this device.
 *
 * Each is its own PouchDB database, `project_local_<uuid>`, holding a `project` document that
 * names it, and is listed in the `mm-local` index so it can be found again without enumerating
 * IndexedDB. The frontend writes the `project` document here and only here: on a server
 * database the service owns it (see `domain/documents/project.ts`).
 *
 * The name lives twice - in the database's `project` document, which travels with the data if
 * the project is ever synchronized, and in the index entry, which lets a list render without
 * opening a database per row. Every operation here writes both, document first: the document is
 * the truth and the entry a convenience, so a failure between the two leaves the truth ahead.
 *
 * @module
 */

import { type LocalCache, type LocalProjectEntry, projectRepositories } from '../data/index.js'
import type { ImportedProject } from '../domain/archive/project-archive.js'
import {
  isProjectDocument,
  PROJECT_DOCUMENT_ID,
  type ProjectDocument,
} from '../domain/documents/project.js'
import { profile } from './composition.js'
import {
  forgetProject,
  localDatabase,
  localProfileCache,
  PROJECT_DATABASE_NAME,
  rawDatabase,
} from './db/project-database.js'
import { cachedProfileOf, type Profile } from './profile.js'
import { type Project, ProjectCreationError } from './projects.js'
import { pouchRefreshTokenStore } from './tokens.js'

/** The prefix of a local-only project's database name. */
const LOCAL_PROJECT_PREFIX = 'project_local_'

/** What this module touches: injectable so a test need not own the browser's databases. */
export interface LocalProjectDependencies {
  readonly cache: () => LocalCache
  readonly database: (dbName: string) => PouchDB.Database
  readonly forget: (dbName: string) => void
  readonly uuid: () => string
  readonly now: () => string
  /**
   * The signed-in account's `sub`, or `undefined` while nobody is — what a new index entry is
   * stamped with (`LocalProjectEntry#account`). See {@link resolveAccount}.
   *
   * @throws ProjectCreationError (`unreachable`) when somebody is signed in but who cannot be
   *   learned yet
   */
  readonly account: () => Promise<string | undefined>
  /**
   * Whether this device holds a session: a stored refresh token. What decides whether the
   * projects page filters by account — not the shell's session state, which is unknown until the
   * refresher first answers, and stays unknown through an offline start.
   */
  readonly signedIn: () => Promise<boolean>
}

/** Where {@link resolveAccount} learns who is signed in: injectable, like the rest. */
export interface AccountSources {
  /** The cached profile's `sub`, or `undefined` when none is cached. May throw if unreadable. */
  readonly cachedSub: () => Promise<string | undefined>
  /** Whether this device holds a session — a stored refresh token — whatever is cached. */
  readonly signedIn: () => Promise<boolean>
  /** `GET /profile`; `undefined` while no access token is held. Throws when unreachable. */
  readonly fetchProfile: () => Promise<Profile | undefined>
  /** Caches a fetched profile, as startup does. */
  readonly remember: (profile: Profile) => Promise<void>
}

/**
 * Who a new index entry belongs to: the signed-in account's `sub`, or `undefined` when nobody
 * is signed in on this device.
 *
 * Why not just the cached profile: the profile is cached by a fetch that `startSyncing` fires
 * and does not await, and that may fail. A project created in that window - or for the whole
 * session, if the fetch failed - would read as made signed out and go unstamped, and nothing
 * stamps it later, so the next account on the device would see it. The stored refresh token
 * alone decides "signed out", in both directions: no cached profile is not proof of it, and a
 * cached profile is not proof against it. While there is a token and no profile, the profile is
 * fetched (and cached, so the listing filter has it too). If it cannot be, the caller is refused
 * rather than handed an entry with no owner.
 *
 * @throws ProjectCreationError (`unreachable`) when signed in and the profile cannot be fetched
 */
export async function resolveAccount(sources: AccountSources): Promise<string | undefined> {
  // The session first: a profile can outlive it (a sign-out whose cleanup half failed), and
  // stamping with it would hide a signed-out project from whoever signs in next.
  if (!(await sources.signedIn())) return undefined
  const cached = await sources.cachedSub().catch(() => undefined)
  if (cached !== undefined) return cached
  let fresh: Profile | undefined
  try {
    fresh = await sources.fetchProfile()
  } catch {
    throw new ProjectCreationError('unreachable')
  }
  // No access token yet: the refresher is between tokens. Same answer for the reader - try again.
  if (fresh === undefined) throw new ProjectCreationError('unreachable')
  // A cache that refuses the write still leaves this stamp right; the listing catches up later.
  await sources.remember(fresh).catch(() => undefined)
  return fresh.sub
}

/** The real sources: the `mm-local` profile cache, the stored refresh token, and the API. */
const accountSources: AccountSources = {
  cachedSub: async () => (await localProfileCache().readProfile())?.sub,
  signedIn: async () => (await pouchRefreshTokenStore(localDatabase()).read()) !== undefined,
  fetchProfile: () => profile().read(),
  remember: (fresh) =>
    localProfileCache().writeProfile(cachedProfileOf(fresh, new Date().toISOString())),
}

/** The real dependencies: the browser's databases and the shared `mm-local` index. */
export const localProjectDefaults: LocalProjectDependencies = {
  cache: localProfileCache,
  database: rawDatabase,
  forget: forgetProject,
  uuid: () => crypto.randomUUID(),
  now: () => new Date().toISOString(),
  account: () => resolveAccount(accountSources),
  signedIn: accountSources.signedIn,
}

/** An optional account stamp, absent rather than empty, like {@link clientField}. */
const accountField = (account: string | undefined): { account?: string } =>
  account === undefined ? {} : { account }

/** An optional client, absent rather than empty so the stored shape matches `isProjectDocument`. */
const clientField = (client: string | undefined): { client?: string } =>
  client === undefined || client === '' ? {} : { client }

/** The stored `project` document, or `undefined` when the database has none (or a malformed one). */
async function readProjectDocument(
  database: PouchDB.Database,
): Promise<(ProjectDocument & { _rev: string }) | undefined> {
  const stored = await readRawProjectDocument(database)
  return isProjectDocument(stored) ? (stored as ProjectDocument & { _rev: string }) : undefined
}

/** Whatever is stored under the `project` id, valid or not, or `undefined` if nothing is. */
async function readRawProjectDocument(
  database: PouchDB.Database,
): Promise<{ _rev: string } | undefined> {
  try {
    return (await database.get(PROJECT_DOCUMENT_ID)) as unknown as { _rev: string }
  } catch (error) {
    if ((error as { status?: unknown }).status === 404) return undefined
    throw error
  }
}

/** How many times a `project` document write re-reads after losing a revision race. */
const WRITE_ATTEMPTS = 3

/**
 * Writes the `project` document, replacing a previous revision's name and client.
 *
 * Keeps `serverDb` if one is already there: this is also reached for a database that was
 * synchronized, and dropping the pointer would sever it from its server project. A *malformed*
 * document is overwritten through its `_rev` rather than left to fail with a 409. Retries a lost
 * revision race a bounded number of times, like the index.
 */
async function writeProjectDocument(
  database: PouchDB.Database,
  name: string,
  client: string | undefined,
): Promise<void> {
  for (let remaining = WRITE_ATTEMPTS; ; remaining -= 1) {
    const raw = await readRawProjectDocument(database)
    const existing = isProjectDocument(raw) ? raw : undefined
    const document: ProjectDocument = {
      _id: PROJECT_DOCUMENT_ID,
      type: 'project',
      name,
      ...clientField(client),
      ...(existing?.serverDb === undefined ? {} : { serverDb: existing.serverDb }),
    }
    try {
      await database.put({
        ...document,
        ...(raw === undefined ? {} : { _rev: raw._rev }),
      } as unknown as PouchDB.Core.PutDocument<object>)
      return
    } catch (error) {
      const conflict = (error as { status?: unknown }).status === 409
      if (!conflict || remaining <= 1) throw error
    }
  }
}

/**
 * Creates a local-only project: its database, its `project` document, its index entry.
 *
 * The entry is written last. A failure earlier leaves an unlisted, nearly empty database -
 * invisible and harmless - rather than a listed project with nothing behind it.
 *
 * @returns the new index entry
 */
export async function createLocalProject(
  input: { readonly name: string; readonly client?: string },
  deps: LocalProjectDependencies = localProjectDefaults,
): Promise<LocalProjectEntry> {
  // Asked first: a refusal (signed in, account not yet known) must leave nothing behind.
  const account = await deps.account()
  const dbName = `${LOCAL_PROJECT_PREFIX}${deps.uuid()}`
  await writeProjectDocument(deps.database(dbName), input.name, input.client)
  const entry: LocalProjectEntry = {
    dbName,
    name: input.name,
    ...clientField(input.client),
    ...accountField(account),
    createdAt: deps.now(),
  }
  await deps.cache().addLocalProject(entry)
  return entry
}

/**
 * A name no listed local project has: the one offered, else `<name> (imported)`, then
 * `<name> (imported 2)` and so on.
 *
 * Only this device's index is consulted. Two projects with one name are allowed, but an import
 * that silently lands beside the project it was exported from would be picked by mistake.
 */
function unusedName(name: string, taken: ReadonlySet<string>): string {
  if (!taken.has(name)) return name
  for (let n = 1; ; n++) {
    const candidate = n === 1 ? `${name} (imported)` : `${name} (imported ${n})`
    if (!taken.has(candidate)) return candidate
  }
}

/**
 * Creates a local-only project from an import: its database, its `project` document, its
 * devices, and last its index entry.
 *
 * The order is {@link createLocalProject}'s, and here it carries more weight: a failure while
 * the devices are written leaves a project with some of them, and listing that would present a
 * partial backup as the whole one. So on any failure the database is destroyed and nothing is
 * listed - the import either happened or did not.
 *
 * @param imported the project and devices, from `readProjectArchive`; validated already
 * @returns the new index entry
 */
export async function importLocalProject(
  imported: ImportedProject,
  deps: LocalProjectDependencies = localProjectDefaults,
): Promise<LocalProjectEntry> {
  const account = await deps.account()
  const taken = new Set((await deps.cache().readLocalProjects()).map((entry) => entry.name))
  const name = unusedName(imported.project.name, taken)
  const dbName = `${LOCAL_PROJECT_PREFIX}${deps.uuid()}`
  const database = deps.database(dbName)
  try {
    await writeProjectDocument(database, name, imported.project.client)
    // Through the repository, so each device gets this device's `updatedAt` stamp (ADR 0010)
    // rather than whatever the file said.
    const { devices } = projectRepositories(database, deps.now)
    for (const device of imported.devices) await devices.save(device)
  } catch (error) {
    await database.destroy().catch(() => undefined)
    deps.forget(dbName)
    throw error
  }
  const entry: LocalProjectEntry = {
    dbName,
    name,
    ...clientField(imported.project.client),
    ...accountField(account),
    createdAt: deps.now(),
  }
  await deps.cache().addLocalProject(entry)
  return entry
}

/** Looks an entry up, failing loudly: a rename of an unlisted project is a caller bug. */
async function entryOf(cache: LocalCache, dbName: string): Promise<LocalProjectEntry> {
  const entry = (await cache.readLocalProjects()).find((candidate) => candidate.dbName === dbName)
  if (entry === undefined) throw new Error(`No local project is indexed as ${dbName}.`)
  return entry
}

/** Renames a local project, in its `project` document and in the index. */
export async function renameLocalProject(
  dbName: string,
  name: string,
  deps: LocalProjectDependencies = localProjectDefaults,
): Promise<void> {
  const entry = await entryOf(deps.cache(), dbName)
  await writeProjectDocument(deps.database(dbName), name, entry.client)
  await deps.cache().updateLocalProject(dbName, { name })
}

/**
 * Sets, or with an empty value clears, a local project's client, in its `project` document and
 * in the index.
 */
export async function setLocalClient(
  dbName: string,
  client: string | undefined,
  deps: LocalProjectDependencies = localProjectDefaults,
): Promise<void> {
  const entry = await entryOf(deps.cache(), dbName)
  await writeProjectDocument(deps.database(dbName), entry.name, client)
  // Rewritten rather than patched: a patch cannot express "no client", and an entry left with a
  // stale one would disagree with its document.
  const { client: _stale, ...rest } = entry
  await deps.cache().addLocalProject({ ...rest, ...clientField(client) })
}

/**
 * Lists this device's copy of a server project in the index, or brings its listing up to date.
 *
 * Writes the index only, never the database: on a server database the service owns the
 * `project` document, and replication brings it down. The entry is what lets the page show the
 * copy's name, and tell it from a server-only project, while offline. Rewritten whole, keeping
 * only when the device first knew of it: a client the server has cleared must go from the entry
 * too, which a patch cannot express.
 *
 * @param project as `POST /projects` or `PATCH /projects/:id` returned it
 */
export async function indexServerProject(
  project: Pick<Project, 'projectId' | 'dbName' | 'name' | 'client' | 'role'>,
  deps: LocalProjectDependencies = localProjectDefaults,
): Promise<void> {
  const cache = deps.cache()
  const existing = (await cache.readLocalProjects()).find(
    (candidate) => candidate.dbName === project.dbName,
  )
  await cache.addLocalProject({
    dbName: project.dbName,
    name: project.name,
    ...clientField(project.client),
    projectId: project.projectId,
    role: project.role,
    // The server listed it for whoever is signed in now, so the stamp is theirs; an earlier
    // stamp stands in only when nobody is (a refresh racing a sign-out). Unlike creating, a
    // refusal is not passed on: the server already holds the project, and failing here would
    // report a create or rename that happened as one that did not.
    ...accountField((await deps.account().catch(() => undefined)) ?? existing?.account),
    createdAt: existing?.createdAt ?? deps.now(),
  })
}

/**
 * Deletes a local project's data and forgets it.
 *
 * **The caller must stop replication of this database first** (a running sync would recreate or
 * fight the destroy) **and must not leave it as the current project** - views holding its
 * repositories would fail after the handle is forgotten.
 *
 * Destroy first, entry second: if the destroy fails the project stays listed and can be tried
 * again, whereas the other order would strand a database nothing names. The memoised handle is
 * dropped either way, because after a failed destroy it may point at a half-removed store.
 */
export async function destroyLocalProject(
  dbName: string,
  deps: LocalProjectDependencies = localProjectDefaults,
): Promise<void> {
  try {
    await deps.database(dbName).destroy()
  } finally {
    deps.forget(dbName)
  }
  await deps.cache().removeLocalProject(dbName)
}

/**
 * Makes today's single `project_local` catalogue the first local project.
 *
 * Idempotent: if it is already indexed nothing is written, so a later call with another name
 * never renames it. It writes only the `project` document and the index entry - the catalogue's
 * devices and rooms are not read or changed. A `project` document that is already there (the
 * index was lost, the database survived) is respected over the name offered, because it is what
 * the user last saw.
 *
 * An empty `project_local` is adopted only on a device that has **never known a project**
 * (ruling C-R7, refined): nothing indexed and no server list remembered. A brand-new device then
 * has one project, which the projects page asks the reader to name, rather than a page with
 * nothing to open and nowhere to record a device. Anywhere else an empty catalogue would be a
 * project nobody made — beside other projects, or for a member who has just removed their last
 * local copy, whose projects are on the server and whose plan it would count against.
 *
 * @param name what to call it, used only when it has no name yet; `''` leaves it to be named
 */
export async function adoptLegacyCatalogue(
  name: string,
  deps: LocalProjectDependencies = localProjectDefaults,
): Promise<void> {
  const cache = deps.cache()
  const indexed = await cache.readLocalProjects()
  if (indexed.some((entry) => entry.dbName === PROJECT_DATABASE_NAME)) return

  const database = deps.database(PROJECT_DATABASE_NAME)
  // `rawDatabase` creates the store on open, so existence is judged by content. An empty one is
  // adopted only as the device's first project; see above.
  if ((await database.info()).doc_count === 0) {
    const known = indexed.length > 0 || (await cache.readProjects()).length > 0
    if (known) return
  }
  const existing = await readProjectDocument(database)
  if (existing === undefined) await writeProjectDocument(database, name, undefined)

  await cache.addLocalProject({
    dbName: PROJECT_DATABASE_NAME,
    name: existing?.name ?? name,
    ...clientField(existing?.client),
    createdAt: deps.now(),
  })
}
