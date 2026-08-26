import memoryAdapter from 'pouchdb-adapter-memory'
import PouchDB from 'pouchdb-core'

PouchDB.plugin(memoryAdapter)

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
