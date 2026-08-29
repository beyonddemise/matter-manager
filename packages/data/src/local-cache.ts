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

/** What is cached about the signed-in user. */
export interface CachedProfile {
  /** The CouchDB user name, `google|1234`. */
  readonly sub: string
  /** BCP 47, as the profile endpoint returns it. `undefined` means "follow the browser". */
  readonly locale?: string
  readonly email?: string
  readonly name?: string
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
 * offline list has to answer — what is it called, may I write to it, which database is it —
 * and every field beyond those is a second copy of a schema to keep in step for no reader.
 */
export interface ServerProject {
  readonly projectId: string
  readonly dbName: string
  readonly name: string
  readonly role: 'owner' | 'manage' | 'write' | 'read'
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
  /**
   * Removes everything.
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

/** PouchDB reports a lost revision race with `status: 409` or `name: 'conflict'`. */
function isConflict(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    ((error as { status?: unknown }).status === 409 ||
      (error as { name?: unknown }).name === 'conflict')
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
        const held = new Map((await storedProjects()).map((project) => [project.projectId, project]))

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
      // Mark first, then decide whether to prune against a fresh revision. Deleting directly
      // from the first read could race with a replica becoming downloaded and hide data the
      // device now holds.
      await amend(projectId, (project) => ({ ...project, accessRemoved: true }))
      await amend(projectId, (project) =>
        project.localState === 'not-downloaded' ? undefined : project,
      )
    },

    async clear(): Promise<void> {
      // `destroy` rather than deleting documents: a deleted document leaves a tombstone that
      // still carries its id, and the point of signing out is that nothing of the previous
      // user remains in this browser.
      await database.destroy()
    },
  }
}
