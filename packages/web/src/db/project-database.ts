/**
 * The one place in the repository that opens a database.
 *
 * `@matter-manager/data` deliberately imports no PouchDB implementation — it is handed an open
 * database — so this is where the browser build is supplied. Keeping that to a single module
 * means the "which PouchDB build is this?" question has exactly one answer, and a test can
 * hand a view its own repositories without any of this loading.
 *
 * @module
 */

import { type ProjectRepositories, projectRepositories } from '@matter-manager/data'
import PouchDB from 'pouchdb-browser'

/**
 * The local catalogue.
 *
 * There is no project concept until M5, and minting a uuid now would produce a database name
 * nobody could reproduce after clearing storage. The `project_` prefix matches the naming this
 * project uses for real project databases, so M5 replaces a constant rather than a scheme.
 */
export const PROJECT_DATABASE_NAME = 'project_local'

let opened: ProjectRepositories | undefined

/**
 * The repositories for the local catalogue, opening the database on first use.
 *
 * Lazy rather than module-scoped: opening IndexedDB at import time would do it in every test
 * that touches anything in this package, including the ones with no interest in a database.
 * Memoised because a second `new PouchDB(name)` is a second handle on the same store, and the
 * change feeds that M2-6 attaches would then fire twice.
 */
export function projectDatabase(): ProjectRepositories {
  opened ??= projectRepositories(new PouchDB(PROJECT_DATABASE_NAME))
  return opened
}
