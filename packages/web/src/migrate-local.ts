/**
 * Moving the catalogue on this device into a project.
 *
 * `project_local` predates accounts and holds everything recorded before signing in. #55 keeps
 * it in the switcher so nothing disappears when somebody signs in; this is how they empty it
 * deliberately, once there is a project to put it in.
 *
 * The decision — which room each device lands in — is `planMigration` in `core`, which is pure
 * and tested there. What is here is the part that touches databases, and the order it does it
 * in.
 *
 * @module
 */

import { planMigration } from '@matter-manager/core'
import type { ProjectRepositories } from '@matter-manager/data'

/** What happened, so the interface can say something true rather than "done". */
export interface MigrationResult {
  readonly devicesMoved: number
  readonly roomsCreated: number
  /** Whether the local catalogue is now empty. False when something was left behind. */
  readonly localCleared: boolean
}

/**
 * Moves every device from one catalogue into another, then empties the first.
 *
 * **Written first, removed second, and never the other way round.** PouchDB has no transactions,
 * so a failure between the two has to leave *something*. Of the two possible half-finished
 * states — the devices in both catalogues, or in neither — only one of them loses nothing, and
 * duplicates are a tidying problem while a gap is the failure this application exists to
 * prevent.
 *
 * A retry is safe: `planMigration` keeps each device's id, so a device already in the target is
 * recognised and skipped rather than written again — which would be a 409, since the second
 * write carries no revision.
 *
 * @param from the local catalogue
 * @param to the project it is moving into
 * @param uuid a fresh uuid per call, for rooms the target does not have
 * @throws whatever the write threw, with the local catalogue untouched
 */
export async function migrateLocalCatalogue(
  from: ProjectRepositories,
  to: ProjectRepositories,
  uuid: () => string = () => crypto.randomUUID(),
): Promise<MigrationResult> {
  const [devices, rooms, targetRooms, targetDevices] = await Promise.all([
    from.devices.list(),
    from.rooms.list(),
    to.rooms.list(),
    to.devices.list(),
  ])

  const plan = planMigration(devices, rooms, targetRooms, uuid)

  // Already there, from a move that was interrupted after writing this one. Skipped rather than
  // written again: the second write carries no `_rev` and PouchDB answers 409, and carrying the
  // target's `_rev` instead would overwrite whatever has happened to the device *in the project*
  // since - notes added, a room corrected - with a stale copy from the catalogue it came from.
  //
  // The local copy is still removed below. It has been moved; doing it twice does not un-move it.
  const alreadyThere = new Set(targetDevices.map((device) => device._id))
  const toWrite = plan.devices.filter((device) => !alreadyThere.has(device._id))

  // Rooms first, and sequentially. A device pointing at a room that does not exist yet is a
  // broken record, and the room writes are few - one per room the target lacks - so there is
  // nothing to gain from overlapping them.
  for (const room of plan.rooms) await to.rooms.save(room)
  for (const device of toWrite) await to.devices.save(device)

  // Only now. Everything above either wrote or threw, so reaching this line means the project
  // holds every device the local catalogue did.
  let localCleared = true
  try {
    for (const device of devices) await from.devices.remove(device)
    for (const room of rooms) await from.rooms.remove(room)
  } catch {
    // The move succeeded; the tidying did not. Saying so beats claiming a clean result, because
    // the reader will otherwise find their devices in two places and conclude the move went
    // wrong - when in fact nothing was lost, which is the whole point.
    localCleared = false
  }

  return {
    // What this call actually wrote. A device that was already there was moved by the call
    // before this one, and reporting it again would tell the reader more happened than did.
    devicesMoved: toWrite.length,
    roomsCreated: plan.rooms.length,
    localCleared,
  }
}
