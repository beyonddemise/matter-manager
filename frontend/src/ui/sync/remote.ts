/**
 * The CouchDB database at the other end, with a credential attached.
 *
 * **The token is read per request, not captured once.** An access token lives about an hour and
 * a replication lives as long as the tab; a handle built with the token that happened to be
 * held at construction would work, keep working, and then quietly stop — and `retry: true` means
 * it would stop by *retrying forever*, which reports as "offline" on a perfectly good network.
 *
 * @module
 */

/**
 * A remote database handle.
 *
 * Structural rather than PouchDB's own type: this module never touches the handle, it only
 * builds one and hands it to `replicateProject`, whose `Reachable` is the same shape. Naming
 * PouchDB here would import a type for the sake of a value that is passed straight through.
 */
export interface RemoteDatabase {
  info(): Promise<unknown>
}

/** How a remote database is opened. Injected so a test needs no PouchDB and no server. */
export type OpenRemote = (
  url: string,
  options: { fetch: (url: RequestInfo | URL, init?: RequestInit) => Promise<Response> },
) => RemoteDatabase

/** Where the project databases live, and how to prove who is asking. */
export interface RemoteOptions {
  /**
   * Where CouchDB is: an absolute URL (`https://couch.matter-manager.example`), or a path on
   * {@link origin} (`/db`, the same-origin proxy in `functions/db/`).
   */
  readonly couchUrl: string
  /**
   * What a relative {@link couchUrl} is resolved against: the page's own origin in production.
   * Without it, a relative `couchUrl` throws rather than opening anything.
   */
  readonly origin?: string
  /** The current access token, or `undefined` when there is none to send. */
  readonly token: () => string | undefined
  /** Opens the database. `new PouchDB` in production. */
  readonly open: OpenRemote
  /** `fetch`, for the request the token is attached to. */
  readonly fetchImpl?: typeof fetch
}

/**
 * Opens one project's remote database.
 *
 * The `Authorization` header is added by a `fetch` wrapper rather than by a URL credential:
 * CouchDB accepts `https://user:password@host`, and a URL is logged, sent as a referrer and
 * kept in history in ways a header is not. This deployment has no password to put there anyway
 * — the browser holds a short-lived JWT that CouchDB validates for itself (M4-4).
 *
 * @param dbName the project's database, as `GET /projects` reported it. Not built from a
 *   project id here: one place assembles that name, and it is the API's `projects/names.ts`.
 */
export function remoteProject(dbName: string, options: RemoteOptions): RemoteDatabase {
  // Why resolved: PouchDB picks its adapter from the name. Only `http(s)://` reaches a server;
  // anything else, `/db/project_…` included, silently becomes a second IndexedDB database in this
  // browser, and replicating into it reports "synced" while nothing leaves the device.
  const base = new URL(options.couchUrl, options.origin).href.replace(/\/+$/, '')
  const fetchImpl = options.fetchImpl ?? fetch

  return options.open(`${base}/${dbName}`, {
    fetch: (url, init) => {
      const headers = new Headers(init?.headers)
      const token = options.token()
      // No header at all when there is no token, rather than `Bearer undefined`. CouchDB would
      // reject that as a malformed credential, which is a different failure from being
      // unauthenticated and a more confusing one to read in a log.
      if (token !== undefined) headers.set('authorization', `Bearer ${token}`)

      return fetchImpl(url, { ...init, headers })
    },
  })
}
