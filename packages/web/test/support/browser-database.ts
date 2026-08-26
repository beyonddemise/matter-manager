import { type ProjectRepositories, projectRepositories } from '@matter-manager/data'
import PouchDB from 'pouchdb-browser'

let counter = 0

/** A database and the means to get rid of it. */
export interface TestDatabase {
  readonly repositories: ProjectRepositories
  destroy(): Promise<void>
}

/**
 * A fresh IndexedDB-backed database, per test.
 *
 * `pouchdb-browser` rather than a fake, because these tests run in a real browser and the
 * shipping build is the thing worth exercising: this is the only place the application's
 * choice of PouchDB build is proved to work at all. `packages/data`'s own tests already cover
 * the repository logic against the memory adapter in Node, so nothing is duplicated here —
 * what is added is the wiring.
 *
 * A distinct name per call. PouchDB caches by name, so two tests sharing one would share
 * documents, and a failure would depend on which test ran first.
 */
export function browserDatabase(): TestDatabase {
  counter += 1
  const database = new PouchDB(`matter-manager-test-${counter}`)
  return {
    repositories: projectRepositories(database),
    destroy: async () => {
      await database.destroy()
    },
  }
}
