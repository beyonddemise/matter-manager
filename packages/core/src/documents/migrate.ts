/**
 * Moving the catalogue that lives only on one device into a project.
 *
 * Everything recorded before signing in is in `project_local`. #55 keeps it, so nothing
 * disappears the moment somebody signs in — and this is how they empty it deliberately, once
 * they have a project to put it in.
 *
 * **The hard part is the rooms, not the devices.** Both catalogues name rooms by path, and
 * ADR 0006 settled long ago that `Ground Floor/Kitchen` and `ground floor / kitchen` are the
 * same room. A move that copied rooms by id would put a second Kitchen into a project that
 * already has one: the duplicate M1-5 and M2-5 exist to prevent, walking back in through the
 * door nobody was watching.
 *
 * This module **plans, and does not write** — the same rule as `new-device.ts`, and for the same
 * reason. Returning the documents rather than saving them is what makes "a failed move loses
 * nothing" true by construction: there is nothing here that could lose anything.
 *
 * @module
 */

import { roomPathKey } from '../rooms/path.js'
import { documentId } from './ids.js'
import type { DeviceDocument, RoomDocument, Unsaved } from './types.js'

/** What to write into the target project, in this order. */
export interface MigrationPlan {
  /** Rooms the target does not have yet. Write these first. */
  readonly rooms: readonly Unsaved<RoomDocument>[]
  /** Every device, each pointing at a room that will exist by the time it is written. */
  readonly devices: readonly Unsaved<DeviceDocument>[]
}

/**
 * Plans the move.
 *
 * @param devices every device in the local catalogue
 * @param rooms every room in the local catalogue
 * @param targetRooms the rooms the project already has, so its own are reused rather than
 *   duplicated
 * @param uuid a fresh uuid per call, for the rooms that have to be created
 */
export function planMigration(
  devices: readonly DeviceDocument[],
  rooms: readonly RoomDocument[],
  targetRooms: readonly RoomDocument[],
  uuid: () => string,
): MigrationPlan {
  const localById = new Map(rooms.map((room) => [room._id, room]))
  const targetByKey = new Map(targetRooms.map((room) => [roomPathKey(room.path), room._id]))

  const created: Unsaved<RoomDocument>[] = []

  /**
   * The id this device's room will have in the target.
   *
   * Three cases, in order: the target already has that room, this move has already planned it,
   * or it has to be created. The middle one is why `targetByKey` is written to rather than
   * merely read — two devices in the same new room must arrive in *one* room, not two.
   */
  const roomIdFor = (localRoomId: string): string => {
    const local = localById.get(localRoomId)
    // A device whose room is missing keeps the id it had. Losing the device instead would be the
    // one outcome a move must never have, and an id pointing at nothing is what `rooms/list.ts`
    // already copes with.
    if (local === undefined) return localRoomId

    const key = roomPathKey(local.path)
    const existing = targetByKey.get(key)
    if (existing !== undefined) return existing

    const id = documentId('room', uuid())
    // The path is carried across as the local catalogue spelled it. Case is the user's own
    // decision (ADR 0006), and rewriting it to match the target's spelling would be this
    // function having an opinion about somebody's house.
    created.push({ _id: id, type: 'room', path: local.path })
    targetByKey.set(key, id)
    return id
  }

  const planned = devices.map((device) => {
    // `_rev` and `updatedAt` are dropped: a revision belongs to the database that issued it, and
    // writing one into another database is a conflict at best. The **id is kept**, so a move
    // interrupted half way and retried writes the same document again rather than a second copy
    // of it.
    const { _rev: _dropped, updatedAt: _stamp, ...rest } = device
    return { ...rest, roomId: roomIdFor(device.roomId) } satisfies Unsaved<DeviceDocument>
  })

  // `created` is built while the devices are mapped, so this reads the finished list rather than
  // one that is still being appended to.
  return { rooms: created, devices: planned }
}
