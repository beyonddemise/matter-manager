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

/** Reading and writing what the server said. Deliberately small. */
export interface LocalCache {
  /** The cached profile, or `undefined` if the server has never been reached. */
  readProfile(): Promise<CachedProfile | undefined>
  /** Replaces the cached profile. */
  writeProfile(profile: CachedProfile): Promise<void>
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

/**
 * Builds the cache over an open database.
 *
 * @param database an open PouchDB database, supplied by the caller — this package constructs
 *   none, for the reason in `index.ts`
 */
export function localCache(database: PouchDB.Database): LocalCache {
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

    async clear(): Promise<void> {
      // `destroy` rather than deleting documents: a deleted document leaves a tombstone that
      // still carries its id, and the point of signing out is that nothing of the previous
      // user remains in this browser.
      await database.destroy()
    },
  }
}
