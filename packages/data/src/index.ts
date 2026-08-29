/**
 * `@matter-manager/data` - persistence over PouchDB.
 *
 * This package **constructs no database and imports no PouchDB implementation.** It is handed
 * an open database and works against it. The reason is concrete: `pouchdb-browser`, the
 * allowlisted runtime build, references `self` at module scope and cannot be imported in Node,
 * so code that depended on it could only ever be tested in a browser. Inverting the dependency
 * keeps these tests in Node, in milliseconds, like `core`'s.
 *
 * Merge *logic* is not here. Deciding how two conflicting remark arrays combine is a pure
 * function over plain data and lives in `core`. This package finds the conflicts and applies
 * that decision — see `conflicts.ts` — but it does not make it.
 *
 * @module
 */

export {
  type Conflicted,
  type ConflictResolver,
  type ConflictWatch,
  conflictResolver,
  type MergeStrategy,
  type WatchOptions,
  watchConflicts,
} from './conflicts.js'
export {
  type CachedProfile,
  type LocalCache,
  localCache,
  PROFILE_ID,
} from './local-cache.js'
export { type ProjectRepositories, projectRepositories } from './project-database.js'
export { type Repository, repository } from './repository.js'
