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

import type { LocalCache, LocalProjectEntry } from '../data/index.js'
import {
  isProjectDocument,
  PROJECT_DOCUMENT_ID,
  type ProjectDocument,
} from '../domain/documents/project.js'
import {
  forgetProject,
  localProfileCache,
  PROJECT_DATABASE_NAME,
  rawDatabase,
} from './db/project-database.js'
import type { Project } from './projects.js'

/** The prefix of a local-only project's database name. */
const LOCAL_PROJECT_PREFIX = 'project_local_'

/** What this module touches: injectable so a test need not own the browser's databases. */
export interface LocalProjectDependencies {
  readonly cache: () => LocalCache
  readonly database: (dbName: string) => PouchDB.Database
  readonly forget: (dbName: string) => void
  readonly uuid: () => string
  readonly now: () => string
}

/** The real dependencies: the browser's databases and the shared `mm-local` index. */
export const localProjectDefaults: LocalProjectDependencies = {
  cache: localProfileCache,
  database: rawDatabase,
  forget: forgetProject,
  uuid: () => crypto.randomUUID(),
  now: () => new Date().toISOString(),
}

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
  const dbName = `${LOCAL_PROJECT_PREFIX}${deps.uuid()}`
  await writeProjectDocument(deps.database(dbName), input.name, input.client)
  const entry: LocalProjectEntry = {
    dbName,
    name: input.name,
    ...clientField(input.client),
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
