import memoryAdapter from 'pouchdb-adapter-memory'
import PouchDB from 'pouchdb-core'
import replication from 'pouchdb-replication'

PouchDB.plugin(memoryAdapter)
// Replication, in the tests only. A conflict is a *shape of the revision tree*, and the honest
// way to produce one is to let the replication protocol produce it. A hand-built `_conflicts`
// would be a test asserting against its own fabrication of the thing under test.
PouchDB.plugin(replication)

let counter = 0

/**
 * A fresh in-memory database.
 *
 * `pouchdb-core` rather than `pouchdb-browser`: the browser build references `self` at module
 * scope and cannot be imported in Node at all. That is the reason `packages/data/src` takes a
 * database instance instead of constructing one — see the design note for M2-4.
 *
 * A distinct name per call, because PouchDB caches by name and two tests sharing one would
 * share documents, making order matter and failures depend on which test ran first.
 */
export function memoryDatabase(): PouchDB.Database {
  counter += 1
  return new PouchDB(`test-${counter}`, { adapter: 'memory' })
}

/** A clock that returns fixed timestamps in order, so `updatedAt` is assertable. */
export function fixedClock(...timestamps: readonly string[]): () => string {
  let index = 0
  return () => {
    const value = timestamps[Math.min(index, timestamps.length - 1)]
    index += 1
    if (value === undefined) throw new Error('fixedClock needs at least one timestamp')
    return value
  }
}

/**
 * Two devices and the server they both replicate through.
 *
 * The topology is the one the scenarios describe: neither device ever talks to the other, so
 * every conflict here arrives the way a real one does — through a server, after the fact, with
 * both writes already committed locally.
 */
export interface Replicas {
  readonly deviceA: PouchDB.Database
  readonly server: PouchDB.Database
  readonly deviceB: PouchDB.Database
}

/** Three databases, nothing replicated yet. */
export function replicas(): Replicas {
  return { deviceA: memoryDatabase(), server: memoryDatabase(), deviceB: memoryDatabase() }
}

/** One-shot replication, both directions, awaited. This is "connectivity returned". */
export async function syncOnce(local: PouchDB.Database, remote: PouchDB.Database): Promise<void> {
  await local.replicate.to(remote)
  await local.replicate.from(remote)
}

/**
 * Both devices reconnect, one after the other.
 *
 * Twice round, and that is not superstition: A pushes, then B pushes *and pulls* — which is the
 * moment the conflict exists — and A only learns about it on a second pass. A single round
 * would leave device A holding a document it believes is uncontested, and the scenarios ask
 * what **both** devices show.
 */
export async function reconnect({ deviceA, server, deviceB }: Replicas): Promise<void> {
  await syncOnce(deviceA, server)
  await syncOnce(deviceB, server)
  await syncOnce(deviceA, server)
  await syncOnce(deviceB, server)
}
