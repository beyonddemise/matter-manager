/**
 * The repositories of one `project_<uuid>` database.
 *
 * Grouped rather than constructed one at a time, because they always come together: a project
 * database holds devices and rooms, and a caller holding one without the other cannot resolve
 * a device's `roomId`.
 *
 * @module
 */

import type { DeviceDocument, RoomDocument } from '@matter-manager/core'
import { type Repository, repository } from './repository.js'

/** Everything M2 reads and writes in a project database. */
export interface ProjectRepositories {
  readonly devices: Repository<DeviceDocument>
  readonly rooms: Repository<RoomDocument>
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
  return {
    devices: repository<DeviceDocument>(database, 'device', now),
    rooms: repository<RoomDocument>(database, 'room', now),
  }
}
