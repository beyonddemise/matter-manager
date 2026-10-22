/**
 * The repositories of one `project_<uuid>` database, and the conflict policy they run under.
 *
 * A project database holds devices; their rooms are a property of each device (ADR 0021), so
 * there is nothing else to pair them with. This is also the one place the merge strategies are
 * wired, to reads and to the change feed alike, so the two cannot disagree.
 *
 * @module
 */

import { type DeviceDocument, documentTypeOf, mergeDevice } from '../domain/index.js'
import {
  type ConflictWatch,
  conflictResolver,
  watchConflicts as watchDatabaseConflicts,
} from './conflicts.js'
import { type Repository, repository } from './repository.js'

/** Everything M2 reads and writes in a project database. */
export interface ProjectRepositories {
  readonly devices: Repository<DeviceDocument>
  /**
   * Starts resolving conflicts as replication delivers them.
   *
   * Reads resolve what they touch, which is enough for anything a user is looking at. This is
   * for everything else: ADR 0010 requires resolution on every change event, because a conflict
   * arrives asynchronously by replication, on a device whose user may be doing nothing at all,
   * and `_conflicts` accumulate on every document nobody happens to open.
   *
   * @param onError called when a resolution fails; unhandled otherwise
   */
  watchConflicts(onError?: (error: unknown) => void): ConflictWatch
}

/** The system clock, as an ISO-8601 UTC string. */
const systemClock = (): string => new Date().toISOString()

/**
 * Builds the repositories for an open project database.
 *
 * @param database an open PouchDB database - this package never opens one, see `repository.ts`
 * @param now the clock; defaults to the system clock, and tests pass their own
 */
export function projectRepositories(
  database: PouchDB.Database,
  now: () => string = systemClock,
): ProjectRepositories {
  // One resolver for the database, so a read and the change feed reaching the same conflict at
  // the same moment share one resolution instead of racing to write two.
  const resolver = conflictResolver(database)

  const devices = repository<DeviceDocument>(database, 'device', now, (document) =>
    resolver.resolve(document, mergeDevice),
  )

  return {
    devices,

    watchConflicts(onError?: (error: unknown) => void): ConflictWatch {
      return watchDatabaseConflicts(database, {
        onConflicted: async (document) => {
          // The change feed reports every document down one channel, so the strategy is chosen
          // by id — through `core`'s own prefix table rather than a literal here, because a
          // second copy of "what a device id looks like" is a copy that can drift. A document
          // this application did not write (or no longer writes, like a `room:` document from
          // before ADR 0021) is left alone rather than merged by a guess.
          //
          // The cast is the honest shape of a change feed: it yields documents of no
          // particular type, and this is the point at which the id says which one it is.
          if (documentTypeOf(document._id) !== 'device') return undefined
          return resolver.resolve(document as DeviceDocument, mergeDevice)
        },
        ...(onError === undefined ? {} : { onError }),
      })
    },
  }
}
