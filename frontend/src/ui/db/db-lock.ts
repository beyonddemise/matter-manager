/**
 * Cross-tab coordination of writes against destroys, one Web Lock per database (#220).
 *
 * Promoting a project and removing its local copy verify a database's `update_seq` and then
 * destroy it. This tab's views are moved away first, but another tab with the same project open
 * is not: a write it lands between the final check and the destroy would be destroyed unsent.
 * Web Locks close that window, because the browser holds them across tabs of one origin and
 * releases them when a tab dies, which no hand-rolled flag in storage can promise.
 *
 * The protocol, on the lock named `mm-db:<dbName>`:
 *
 * - **Every document write takes it `shared`** for the duration of the write. Shared holders do
 *   not wait for each other, so concurrent writes stay concurrent. One wrap on `bulkDocs` covers
 *   them all: PouchDB routes `put`, `post`, `remove`, the attachment writes and incoming
 *   replication batches through it ({@link coordinateWrites}).
 * - **A destroy takes it `exclusive`** across the final check and the destroy
 *   ({@link withDestroyLock}). It is granted only once every write in flight has finished, and
 *   every write that arrives while it is held waits. A write released after the destroy fails
 *   visibly — the store under its handle is gone — instead of landing silently in a database
 *   that was just verified as fully transferred.
 *
 * The destroy itself must **not** take the shared lock (it runs inside the exclusive one, and a
 * lock request waits even on its own context's holds), which is why only `bulkDocs` is wrapped.
 *
 * **Fallback:** a browser without `navigator.locks` (checked on every call, never cached) gets
 * today's behaviour — the work runs unserialized — rather than a crash. The residual risk there
 * is exactly the one this module removes elsewhere, and `update_seq` still bounds it to the last
 * round trip.
 *
 * @module
 */

/** The Web Lock guarding one database, shared by writers, exclusive for a destroy. */
export function databaseLockName(dbName: string): string {
  return `mm-db:${dbName}`
}

/** `navigator.locks` where the browser has it; `undefined` is the explicit fallback. */
function lockManager(): LockManager | undefined {
  if (typeof navigator === 'undefined') return undefined
  return (navigator as { locks?: LockManager }).locks
}

/** Runs `work` holding the database's lock in `mode`, or bare where there are no Web Locks. */
async function withDatabaseLock<T>(
  dbName: string,
  mode: LockMode,
  work: () => Promise<T>,
): Promise<T> {
  const locks = lockManager()
  if (locks === undefined) return work()
  return locks.request(databaseLockName(dbName), { mode }, work) as Promise<T>
}

/**
 * Runs one write under the database's shared lock: concurrent with other writes, never with a
 * destroy. Taken per write rather than for as long as a handle is open, because handles stay
 * open for the life of the page — a destroy that had to wait for them would wait forever.
 */
export function withWriteLock<T>(dbName: string, work: () => Promise<T>): Promise<T> {
  return withDatabaseLock(dbName, 'shared', work)
}

/**
 * Runs a destructive step under the database's exclusive lock: after every write in flight,
 * before every write that arrives while it runs. The destructive actions hold it across their
 * final `update_seq` check *and* the destroy, so nothing can land in between.
 */
export function withDestroyLock<T>(dbName: string, work: () => Promise<T>): Promise<T> {
  return withDatabaseLock(dbName, 'exclusive', work)
}

/**
 * Makes a PouchDB handle's writes take the shared lock, and returns the same handle.
 *
 * Only `bulkDocs` is wrapped — the one funnel every document write goes through (see the module
 * doc). The wrapper replaces the instance's own `bulkDocs` (PouchDB assigns it per instance, so
 * internal callers like `put` reach the wrapper too) and keeps both calling conventions: the
 * promise is returned as ever, and a caller that passed a callback is answered through it by
 * PouchDB itself, so for those the promise's duplicate rejection is deliberately swallowed.
 */
export function coordinateWrites<D extends PouchDB.Database>(dbName: string, database: D): D {
  const original = database.bulkDocs.bind(database) as (...args: unknown[]) => Promise<unknown>
  const locked = (...args: unknown[]): Promise<unknown> => {
    const result = withWriteLock(dbName, () => original(...args))
    if (typeof args[args.length - 1] === 'function') result.catch(() => undefined)
    return result
  }
  database.bulkDocs = locked as typeof database.bulkDocs
  return database
}
