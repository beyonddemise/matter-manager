import PouchDB from 'pouchdb-browser'
import { localCache } from '../../../src/data/index.js'
import type { LocalProjectDependencies } from '../../../src/ui/local-projects.js'

let counter = 0
const created: PouchDB.Database[] = []

/**
 * A local index and project databases of the test's own, for the shell's `projectStore` seam.
 *
 * The shell adopts the first-run catalogue and reads the index on every mount; without this, a
 * shell test would write a `project` document into the browser's real `project_local` and list
 * it in the real `mm-local`, and the next file to read either would find it. Names are unique per
 * call, because PouchDB caches handles by name.
 */
export function isolatedProjectStore(): LocalProjectDependencies {
  counter += 1
  const prefix = `shell-test-${counter}-${Date.now()}`
  const cacheDatabase = new PouchDB(`${prefix}-mm-local`)
  created.push(cacheDatabase)
  const cache = localCache(cacheDatabase)
  const opened = new Map<string, PouchDB.Database>()
  return {
    cache: () => cache,
    database: (dbName) => {
      let database = opened.get(dbName)
      if (database === undefined) {
        database = new PouchDB(`${prefix}-${dbName}`)
        opened.set(dbName, database)
        created.push(database)
      }
      return database
    },
    forget: (dbName) => void opened.delete(dbName),
    uuid: () => crypto.randomUUID(),
    now: () => '2026-10-03T08:00:00.000Z',
  }
}

/** Destroys every database the stores above created. For an `afterEach`. */
export async function destroyProjectStores(): Promise<void> {
  await Promise.all(created.splice(0).map((database) => database.destroy().catch(() => {})))
}
