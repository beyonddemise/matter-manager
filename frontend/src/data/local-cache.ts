/**
 * `mm-local`: what the server has told this browser, kept so the browser stays usable without
 * one.
 *
 * A PouchDB database that **exists only here and is never given a remote counterpart**. It
 * caches the two things that are server-only in an application where everything else works
 * offline — the profile now, the project list at M5 (ADR 0012).
 *
 * ## It is a cache, not a source of truth, and the distinction is a security one
 *
 * **A permission check that reads `mm-local` is a defect.** The cache decides what the client
 * *attempts*; CouchDB's `_security` decides what *succeeds*. Any code that consults this to
 * decide whether something is allowed has moved an authorisation decision onto the machine of
 * the person it is meant to constrain — where it can be edited in a devtools console.
 *
 * ## Never synchronised, structurally
 *
 * The issue asks for a test that fails if anything calls `sync()` on this database. There is
 * one. But the stronger guarantee is the shape: {@link LocalCache} exposes reading, writing and
 * clearing, and **never hands back the PouchDB handle**. A caller cannot replicate what it
 * cannot reach, so "nobody synced it" stops being a thing to remember and becomes a thing that
 * cannot be expressed.
 *
 * That matters more than tidiness. Replicating this database would push a *cached copy of
 * server state* back at the server as though it were user data — and pull other people's
 * cached state down.
 *
 * @module
 */

import { isConflict } from './errors.js'

/** What is cached about the signed-in user. */
export interface CachedProfile {
  /** The CouchDB user name, `google|1234`. */
  readonly sub: string
  /** BCP 47, as the profile endpoint returns it. `undefined` means "follow the browser". */
  readonly locale?: string
  readonly email?: string
  readonly name?: string
  /**
   * The account's plan, as the server reported it. A plain string: it is whatever an older or
   * newer build wrote, and `planOf` decides what this build makes of it.
   */
  readonly plan?: string
  /** The server's project limit for the account; `-1` is unlimited. */
  readonly projectLimit?: number
  /** When this was fetched, ISO-8601. For showing how stale a cached answer is. */
  readonly fetchedAt: string
}

/** The document id the profile is cached under. One user per browser profile. */
export const PROFILE_ID = 'cache:profile'

/** Whether this device holds a replica of a project, as opposed to being allowed to. */
export type ProjectLocalState =
  /** The replica is here and the project opens with no connectivity. */
  | 'downloaded'
  /** Listed by the server, never opened on this device. */
  | 'not-downloaded'

/**
 * A project as the server described it.
 *
 * Deliberately **not** the whole of `GET /projects`. This is a cache of the questions an
 * offline list has to answer — what is it called, who is it for, may I write to it, is it put
 * away, which database is it — and every field beyond those is a second copy of a schema to keep
 * in step for no reader.
 */
export interface ServerProject {
  readonly projectId: string
  readonly dbName: string
  readonly name: string
  readonly role: 'owner' | 'manage' | 'write' | 'read'
  /** Who the project is for, when the server named one. Absent rather than empty. */
  readonly client?: string
  /**
   * Whether the server has put the project away. Optional because lists cached by older builds
   * lack it; absent reads as not archived. Cached because an offline projects page has to open
   * an archived project's copy read-only, and must not count it.
   */
  readonly archived?: boolean
}

/**
 * A cached project: what the server said, plus what this device knows about its own copy.
 *
 * The two halves have **different owners and different lifetimes**, which is the whole reason
 * this type is not simply {@link ServerProject}. The server's half is replaced wholesale every
 * time the list is fetched; the local half is written by this device and has to survive that.
 */
export interface CachedProject extends ServerProject {
  /**
   * What this device actually has.
   *
   * Not redundant with being listed at all: the server says what you *may* open, and this says
   * what you can open *right now, here*. They diverge constantly, and only this one answers the
   * question a user asks when the train goes into a tunnel.
   */
  readonly localState: ProjectLocalState
  /**
   * Whether access to this project has gone while a copy of it is still on this device.
   *
   * Set from either direction — a list that no longer mentions it, or a replication the server
   * refused — because a user whose project vanishes without explanation concludes the
   * application lost it.
   */
  readonly accessRemoved: boolean
  /** When the server's half was last fetched, ISO-8601. For saying how stale a list is. */
  readonly fetchedAt: string
}

/**
 * A project database that lives on this device and is listed in the index.
 *
 * The index exists because IndexedDB cannot be enumerated portably (`indexedDB.databases()` is
 * missing from Firefox before 126), so "which databases does this browser hold for me" has to be
 * written down. It names every local-only project and every downloaded copy of a server one.
 */
export interface LocalProjectEntry {
  /** The PouchDB name: `project_local_<uuid>`, `project_local`, or a server `project_<id>`. */
  readonly dbName: string
  /** What the project is called. Mirrors the `project` document so a list needs no database. */
  readonly name: string
  /** Who the project is for. Absent rather than empty. */
  readonly client?: string
  /**
   * The server's id for it once it has one. Absent while local-only — except on a local-only
   * database whose promotion has started but not finished: see {@link isLocalOnlyDatabase}.
   */
  readonly projectId?: string
  /**
   * The caller's role on the server project, as last heard when the copy was made or refreshed.
   *
   * Recorded so the projects page can tell a downloaded *shared* project from an owned one when
   * no server list is to hand: owned ones count against the limit and follow the owner's plan.
   * Absent on a copy with a `projectId` reads as owner: counting a project that may be shared
   * can refuse a create that would have fitted, while the opposite reading could create past
   * the limit. Promoting writes `owner`; downloading writes the role the server reported.
   * Meaningless while local-only.
   */
  readonly role?: 'owner' | 'manage' | 'write' | 'read'
  /** When this device first knew of the project, ISO-8601. */
  readonly createdAt: string
}

/**
 * Whether a database name is a local-only project's: today's `project_local` catalogue or a
 * `project_local_<uuid>`.
 *
 * **The name, not the entry's `projectId`, says whether the data is anywhere else.** A promotion
 * records the server's id on the local-only entry the moment `POST /projects` answers, so that a
 * retry does not create a second project, and the data only reaches the server-named copy
 * later. Until it has, the entry has an id and the data is still only here: anything deciding
 * whether a database may be thrown away (signing out, the projects page) has to ask this.
 */
export function isLocalOnlyDatabase(dbName: string): boolean {
  return dbName === 'project_local' || dbName.startsWith('project_local_')
}

/** The id prefix that makes the local index a contiguous, listable key range. */
const LOCAL_PROJECT_PREFIX = 'local:project:'

/** The document id one index entry is stored under. */
const localProjectId = (dbName: string): string => `${LOCAL_PROJECT_PREFIX}${dbName}`

/** The id prefix that makes cached projects a contiguous, listable key range. */
const PROJECT_PREFIX = 'cache:project:'

/** Higher than anything a project id can contain; CouchDB's documented convention. */
const HIGHEST_ID_CHARACTER = '\uFFF0'

/** The document id one project is cached under. */
const projectCacheId = (projectId: string): string => `${PROJECT_PREFIX}${projectId}`

/** A cached project as PouchDB stores it, with the bookkeeping a rewrite needs. */
type StoredProject = CachedProject & { readonly _id: string; readonly _rev: string }

/** How many times a cache mutation re-reads after losing a revision race. */
const WRITE_ATTEMPTS = 3

/** Reading and writing what the server said. Deliberately small. */
export interface LocalCache {
  /** The cached profile, or `undefined` if the server has never been reached. */
  readProfile(): Promise<CachedProfile | undefined>
  /** Replaces the cached profile. */
  writeProfile(profile: CachedProfile): Promise<void>
  /**
   * Every project this browser knows of, in id order.
   *
   * Id order rather than anything a person would recognise: display order is a question about
   * locale and about what the list is sorted by that day, and answering it here would put a
   * collation decision in the storage layer.
   */
  readProjects(): Promise<CachedProject[]>
  /**
   * Replaces the server's half of the list, leaving each project's local half alone.
   *
   * A project the list no longer mentions is **removed if this device holds nothing of it**,
   * and kept but marked {@link CachedProject.accessRemoved} if it does. A project that
   * reappears has that mark cleared, because being re-granted is ordinary.
   *
   * @param projects the list exactly as the server gave it
   * @param fetchedAt when it was fetched; this package holds no clock
   */
  writeProjects(projects: readonly ServerProject[], fetchedAt: string): Promise<void>
  /** Records that this device has, or no longer has, a replica. */
  setLocalState(projectId: string, state: ProjectLocalState): Promise<void>
  /**
   * Records that the server refused replication of this project.
   *
   * Does nothing for a project the cache has never heard of: there is no name to show and
   * nothing on this device to explain, so inventing an entry would put a row in the list that
   * says only that something went wrong somewhere.
   */
  markAccessRemoved(projectId: string): Promise<void>
  /** Every project database this device holds, in id order (the prefix is constant, so name order). */
  readLocalProjects(): Promise<LocalProjectEntry[]>
  /**
   * Lists a database in the index. Re-adding a name replaces its entry, so adopting twice is
   * harmless.
   */
  addLocalProject(entry: LocalProjectEntry): Promise<void>
  /**
   * Changes an entry's fields. Does nothing for a name that is not indexed: inventing an entry
   * would claim a database this device may not hold.
   */
  updateLocalProject(
    dbName: string,
    patch: Partial<Omit<LocalProjectEntry, 'dbName'>>,
  ): Promise<void>
  /** Removes an entry, if there is one. Does not touch the database itself. */
  removeLocalProject(dbName: string): Promise<void>
  /**
   * Removes everything, the local index included (it lives in this database).
   *
   * Called on sign-out. The cache holds a name and an email address, which are the
   * signed-in user's and nobody else's — leaving them behind on a shared machine is the
   * whole reason this exists as an operation rather than as a comment.
   */
  clear(): Promise<void>
}

/** PouchDB reports a missing document with `status: 404`; everything else is a real failure. */
function isMissing(error: unknown): boolean {
  return (
    typeof error === 'object' && error !== null && (error as { status?: unknown }).status === 404
  )
}

/** A row `bulkDocs` reports as a failure. */
function isBulkFailure(result: unknown): boolean {
  return typeof result === 'object' && result !== null && 'error' in result
}

/**
 * Builds the cache over an open database.
 *
 * @param database an open PouchDB database, supplied by the caller — this package constructs
 *   none, for the reason in `index.ts`
 */
export function localCache(database: PouchDB.Database): LocalCache {
  /** A stored document as the cached project it is, without the PouchDB bookkeeping. */
  const asCachedProject = (document: unknown): CachedProject => {
    const { _id, _rev, ...project } = document as CachedProject & {
      _id: string
      _rev: string
    }
    return project as CachedProject
  }

  /** Every cached project as stored, its bookkeeping included, for the writes that replace them. */
  const storedProjects = async (): Promise<StoredProject[]> => {
    const { rows } = await database.allDocs({
      startkey: PROJECT_PREFIX,
      endkey: `${PROJECT_PREFIX}${HIGHEST_ID_CHARACTER}`,
      include_docs: true,
    })
    return rows.flatMap((row) => (row.doc ? [row.doc as unknown as StoredProject] : []))
  }

  /**
   * Changes one cached project in place, doing nothing if it is not there.
   *
   * Read for the `_rev` each time rather than held in memory, for the reason `writeProfile`
   * gives: two tabs writing this cache is ordinary.
   */
  const amend = async (
    projectId: string,
    change: (project: CachedProject) => CachedProject | undefined,
  ): Promise<void> => {
    for (let remaining = WRITE_ATTEMPTS; ; remaining -= 1) {
      let stored: StoredProject | undefined
      try {
        stored = (await database.get(projectCacheId(projectId))) as unknown as StoredProject
      } catch (error) {
        if (isMissing(error)) return
        throw error
      }

      const changed = change(asCachedProject(stored))
      try {
        await database.put({
          ...(changed ?? {}),
          _id: projectCacheId(projectId),
          _rev: stored._rev,
          ...(changed === undefined ? { _deleted: true } : {}),
        } as unknown as PouchDB.Core.PutDocument<object>)
        return
      } catch (error) {
        if (!isConflict(error) || remaining <= 1) throw error
      }
    }
  }

  /**
   * Replaces, changes or deletes one index entry, retrying when another tab wins the revision.
   *
   * Same retry as {@link amend}, over a different key range: `change` receives the stored entry
   * (or `undefined`) and returns what to store, or `undefined` to delete it.
   */
  const rewriteEntry = async (
    dbName: string,
    change: (stored: LocalProjectEntry | undefined) => LocalProjectEntry | undefined,
  ): Promise<void> => {
    const id = localProjectId(dbName)
    for (let remaining = WRITE_ATTEMPTS; ; remaining -= 1) {
      let stored: (LocalProjectEntry & { _rev: string }) | undefined
      try {
        stored = (await database.get(id)) as unknown as LocalProjectEntry & { _rev: string }
      } catch (error) {
        if (!isMissing(error)) throw error
      }

      const { _id, _rev, ...entry } = (stored ?? {}) as LocalProjectEntry & {
        _id?: string
        _rev?: string
      }
      const changed = change(stored === undefined ? undefined : (entry as LocalProjectEntry))
      if (changed === undefined && stored === undefined) return
      try {
        await database.put({
          ...(changed ?? {}),
          _id: id,
          ...(stored === undefined ? {} : { _rev: stored._rev }),
          ...(changed === undefined ? { _deleted: true } : {}),
        } as unknown as PouchDB.Core.PutDocument<object>)
        return
      } catch (error) {
        if (!isConflict(error) || remaining <= 1) throw error
      }
    }
  }

  return {
    async readProfile(): Promise<CachedProfile | undefined> {
      try {
        const document = (await database.get(PROFILE_ID)) as unknown as CachedProfile
        return document
      } catch (error) {
        // "Never fetched" is an answer this application acts on — follow the browser's
        // language — rather than a failure. Anything else still throws: a corrupt or
        // inaccessible database is not the same as an empty one.
        if (isMissing(error)) return undefined
        throw error
      }
    },

    async writeProfile(profile: CachedProfile): Promise<void> {
      // Read for the `_rev` rather than kept in memory. A cache written from two tabs is
      // ordinary, and a stale `_rev` there is a conflict over a value both tabs agree about.
      let rev: string | undefined
      try {
        const existing = (await database.get(PROFILE_ID)) as unknown as { _rev: string }
        rev = existing._rev
      } catch (error) {
        if (!isMissing(error)) throw error
      }

      await database.put({
        ...profile,
        _id: PROFILE_ID,
        ...(rev === undefined ? {} : { _rev: rev }),
      } as unknown as PouchDB.Core.PutDocument<object>)
    },

    async readProjects(): Promise<CachedProject[]> {
      return (await storedProjects()).map(asCachedProject)
    },

    async writeProjects(projects: readonly ServerProject[], fetchedAt: string): Promise<void> {
      for (let remaining = WRITE_ATTEMPTS; ; remaining -= 1) {
        const held = new Map(
          (await storedProjects()).map((project) => [project.projectId, project]),
        )

        const writes = projects.map((project) => {
          const existing = held.get(project.projectId)
          held.delete(project.projectId)
          return {
            ...project,
            // The local half, carried across rather than defaulted. A refresh happens on every
            // reconnection, and one that reset this would report every project as not downloaded
            // moments after connectivity returned.
            localState: existing?.localState ?? 'not-downloaded',
            // Cleared, not carried: this project is in the list the server just sent.
            accessRemoved: false,
            fetchedAt,
            _id: projectCacheId(project.projectId),
            ...(existing === undefined ? {} : { _rev: existing._rev }),
          }
        })

        // Whatever the server did not mention. Removed when this device holds nothing of it, and
        // kept with the mark when it does — see `LocalCache.writeProjects`.
        const departed = [...held.values()].map((project) =>
          project.localState === 'downloaded'
            ? { ...project, accessRemoved: true }
            : { _id: project._id, _rev: project._rev, _deleted: true },
        )

        const results = await database.bulkDocs([
          ...writes,
          ...departed,
        ] as unknown as PouchDB.Core.PutDocument<object>[])
        const failures = results.filter(isBulkFailure)
        const conflict = failures.find(isConflict)
        const failure = failures.find((result) => !isConflict(result))
        if (failure !== undefined) throw failure
        if (conflict === undefined) return
        if (remaining <= 1) throw conflict
      }
    },

    async setLocalState(projectId: string, state: ProjectLocalState): Promise<void> {
      await amend(projectId, (project) =>
        state === 'not-downloaded' && project.accessRemoved
          ? undefined
          : { ...project, localState: state },
      )
    },

    async markAccessRemoved(projectId: string): Promise<void> {
      await amend(projectId, (project) => ({ ...project, accessRemoved: true }))
    },

    async readLocalProjects(): Promise<LocalProjectEntry[]> {
      const { rows } = await database.allDocs({
        startkey: LOCAL_PROJECT_PREFIX,
        endkey: `${LOCAL_PROJECT_PREFIX}${HIGHEST_ID_CHARACTER}`,
        include_docs: true,
      })
      return rows.flatMap((row) => {
        if (!row.doc) return []
        const { _id, _rev, ...entry } = row.doc as unknown as LocalProjectEntry & {
          _id: string
          _rev: string
        }
        return [entry as LocalProjectEntry]
      })
    },

    async addLocalProject(entry: LocalProjectEntry): Promise<void> {
      await rewriteEntry(entry.dbName, () => entry)
    },

    async updateLocalProject(dbName, patch): Promise<void> {
      await rewriteEntry(dbName, (stored) =>
        stored === undefined ? undefined : { ...stored, ...patch, dbName },
      )
    },

    async removeLocalProject(dbName: string): Promise<void> {
      await rewriteEntry(dbName, () => undefined)
    },

    async clear(): Promise<void> {
      // `destroy` rather than deleting documents: a deleted document leaves a tombstone that
      // still carries its id, and the point of signing out is that nothing of the previous
      // user remains in this browser.
      await database.destroy()
    },
  }
}
