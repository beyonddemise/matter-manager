/**
 * The repositories of one `project_<uuid>` database, and the conflict policy they run under.
 *
 * Grouped rather than constructed one at a time, because they always come together: a project
 * database holds devices and rooms, and a caller holding one without the other cannot resolve
 * a device's `roomId`.
 *
 * It is also the only place that can wire the merge strategies, and that is not incidental.
 * `mergeRoom` has to know whether any device still points at the room being deleted, which is a
 * question only something holding *both* repositories can answer — so the pairing that exists
 * for convenience is the same pairing the conflict policy needs.
 *
 * @module
 */

import {
  type DeviceDocument,
  documentTypeOf,
  mergeDevice,
  mergeRoom,
  type RoomDocument,
} from '@matter-manager/core'
import {
  type ConflictWatch,
  conflictResolver,
  watchConflicts as watchDatabaseConflicts,
} from './conflicts.js'
import { type Repository, repository } from './repository.js'

/** Everything M2 reads and writes in a project database. */
export interface ProjectRepositories {
  readonly devices: Repository<DeviceDocument>
  readonly rooms: Repository<RoomDocument>
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

  /**
   * `mergeRoom` with the question it cannot answer from the documents alone already answered.
   *
   * **Always `false`, and that is a statement about the platform rather than about rooms.**
   * `mergeRoom` consults it only when the winning revision is a deletion, and no deletion ever
   * arrives here: a deleted leaf loses to a live one whatever its generation, and a deleted
   * *losing* branch appears in neither `_conflicts` nor the change feed — CouchDB reports those
   * in `_deleted_conflicts`, which PouchDB does not implement. When every branch is deleted the
   * feed carries a bare tombstone with no conflicts on it at all. Both cases are pinned by
   * tests in `conflict-resolver.test.ts`, because this is exactly the kind of claim that would
   * otherwise quietly stop being true.
   *
   * Answering it honestly would mean listing every device on each room conflict, to decide a
   * branch that cannot execute. The room deletion story is M5-9, where the choice is made by
   * the person deleting the room rather than by a merge.
   */
  const mergeRoomInPlace = async (
    winner: RoomDocument,
    losers: readonly RoomDocument[],
  ): Promise<RoomDocument> => mergeRoom(winner, losers, { hasLiveDevices: false })

  const rooms = repository<RoomDocument>(database, 'room', now, (document) =>
    resolver.resolve(document, mergeRoomInPlace),
  )

  return {
    devices,
    rooms,

    watchConflicts(onError?: (error: unknown) => void): ConflictWatch {
      return watchDatabaseConflicts(database, {
        onConflicted: async (document) => {
          // The change feed reports both types down one channel, so the strategy is chosen by
          // id — through `core`'s own prefix table rather than a literal here, because a second
          // copy of "what a device id looks like" is a copy that can drift. A document this
          // application did not write is left alone rather than merged by a guess.
          //
          // The casts are the honest shape of a change feed: it yields documents of no
          // particular type, and this is the point at which the id says which one it is.
          switch (documentTypeOf(document._id)) {
            case 'device':
              return resolver.resolve(document as DeviceDocument, mergeDevice)
            case 'room':
              return resolver.resolve(document as RoomDocument, mergeRoomInPlace)
            default:
              return undefined
          }
        },
        ...(onError === undefined ? {} : { onError }),
      })
    },
  }
}
