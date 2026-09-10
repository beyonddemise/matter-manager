/**
 * Editing the room list: order, rename, delete (M5-9).
 *
 * `path.ts` answers questions about one path. This is the layer above — what a whole list of
 * rooms becomes when one of them changes, and what happens to the devices that were in it.
 *
 * Like `documents/`, everything here **plans and does not write.** That is what lets a deletion
 * touching a room, a new room and nine devices be decided by one pure function and then written
 * in whatever order the store requires. It is also why every function returns *only what
 * changed*: on a shared project, each document rewritten is a document somebody else's phone
 * downloads.
 *
 * The convention `path.ts` sets holds here too — **queries report, transformations refuse.**
 * {@link devicesInRoom} answers a question the interface asks before it prompts; the others have
 * preconditions and throw when they are not met, because the alternative is writing a room list
 * that contradicts itself and finding out weeks later.
 *
 * @module
 */

import { chooseRoom } from '../documents/draft.js'
import type { DeviceDocument, RoomDocument, Unsaved } from '../documents/types.js'
import {
  isNearDuplicateRoomPath,
  normaliseRoomPath,
  renameRoomPath,
  UNASSIGNED_ROOM_PREFIX,
} from './path.js'

/**
 * Where the devices in a room being deleted are to go.
 *
 * A **required** argument of {@link planRoomDeletion}, and that is the whole mechanism behind
 * the story's one scenario: there is no way to express "delete the room and let the devices
 * fall where they may", because no value of this type means that. The choice is made by
 * whoever calls it, which is the person deleting the room.
 */
export type RoomDestination =
  /** An existing room, chosen by the user. */
  | { readonly kind: 'room'; readonly roomId: string }
  /** The `Unassigned` room, created if this project has never needed one. */
  | { readonly kind: 'unassigned' }

/** Everything a deletion touches, decided in one place and written by the caller. */
export interface RoomDeletionPlan {
  /** The room to delete. */
  readonly remove: RoomDocument
  /**
   * The devices to save with a new `roomId`, and nothing else changed.
   *
   * Empty when the room held nothing, which is the ordinary case and needs no prompt.
   */
  readonly reassign: readonly Unsaved<DeviceDocument>[]
  /**
   * The `Unassigned` room, when devices are going there and the project has never had one.
   *
   * **Write it before the devices.** A device pointing at a room that does not exist yet is
   * the orphan this whole operation exists to avoid.
   */
  readonly create?: Unsaved<RoomDocument>
}

/** Compares two strings, returning the usual negative, zero or positive. */
const compareText = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0)

/**
 * The order to show rooms in: the ones somebody arranged, then the rest by path.
 *
 * `sortKey` is a **manual position over the whole list**, not a position among siblings. The
 * hierarchy here is derived from the path (ADR 0006), so an intermediate level like
 * `Ground Floor` may have no document at all — and a sibling ordering would need a `sortKey` on
 * a room that does not exist.
 *
 * A room nobody has arranged sorts after every room somebody has, rather than being given an
 * invented position among them. Inventing one would move it the first time anybody dragged
 * anything else.
 *
 * Returns a new array. `sort` works in place, and reordering the caller's list is reordering a
 * list something else is rendering.
 */
export function roomsInOrder(rooms: readonly RoomDocument[]): readonly RoomDocument[] {
  return [...rooms].sort((a, b) => {
    if (a.sortKey !== b.sortKey) {
      if (a.sortKey === undefined) return 1
      if (b.sortKey === undefined) return -1
      return a.sortKey - b.sortKey
    }
    return compareText(a.path, b.path)
  })
}

/**
 * Numbers the rooms into the given order, returning only the ones that move.
 *
 * @param orderedIds every room id, in the order they are to appear
 * @param rooms the project's rooms
 * @throws {RangeError} If `orderedIds` is not exactly the rooms, each once. A partial order
 *   says where two rooms go and nothing about the rest, so every answer would be invented —
 *   and the plausible-looking guess, "reorder the ones I recognise", drops the others off the
 *   end of the list.
 */
export function reorderRooms(
  orderedIds: readonly string[],
  rooms: readonly RoomDocument[],
): readonly Unsaved<RoomDocument>[] {
  const byId = new Map(rooms.map((entry) => [entry._id, entry]))
  const named = new Set(orderedIds)

  if (named.size !== orderedIds.length || orderedIds.length !== rooms.length) {
    throw new RangeError(
      `A room order must list every room exactly once; received ${orderedIds.length} ids for ${rooms.length} rooms.`,
    )
  }

  return orderedIds.flatMap((roomId, position) => {
    const existing = byId.get(roomId)
    if (existing === undefined) {
      throw new RangeError(`Cannot order ${JSON.stringify(roomId)}; it is not a room here.`)
    }
    // Only the ones that move. A drag past one neighbour changes two rooms, and rewriting all
    // forty would replicate all forty.
    if (existing.sortKey === position) return []
    const { updatedAt: _stamp, ...rest } = existing
    return [{ ...rest, sortKey: position }]
  })
}

/**
 * Renames a room and everything inside it, returning only the rooms that change.
 *
 * The per-path rule is `renameRoomPath`'s, so the segment-boundary check that keeps `Floor 10`
 * out of a rename of `Floor 1` has exactly one implementation.
 *
 * @throws {RangeError} If any renamed room would land on a room that is not being renamed —
 *   including one that differs only in ways nobody would notice. Two documents with the same
 *   path are two rooms a person cannot tell apart, which is the duplicate M1-5 and M2-5 both
 *   exist to prevent, arriving through the one door nobody was watching.
 * @throws {RoomPathError} If `from` or `to` is not a usable room path.
 */
export function renameRoom(
  from: string,
  to: string,
  rooms: readonly RoomDocument[],
): readonly Unsaved<RoomDocument>[] {
  const moved = rooms.flatMap((entry) => {
    const path = renameRoomPath(entry.path, from, to)
    return path === normaliseRoomPath(entry.path) ? [] : [{ room: entry, path }]
  })

  // Compared against the rooms staying put, not against the whole list: a room colliding with
  // another room that is also moving out of the way is not a collision.
  const staying = rooms.filter((entry) => !moved.some(({ room }) => room._id === entry._id))

  for (const { path } of moved) {
    const clash = staying.find((entry) => isNearDuplicateRoomPath(entry.path, path))
    if (clash !== undefined) {
      throw new RangeError(
        `Renaming to ${JSON.stringify(path)} would collide with the existing room ${JSON.stringify(clash.path)}.`,
      )
    }
  }

  return moved.map(({ room, path }) => {
    // `updatedAt` dropped rather than carried: the repository owns the stamp, and it is half of
    // the total order the conflict merge depends on (ADR 0010).
    const { updatedAt: _stamp, ...rest } = room
    return { ...rest, path }
  })
}

/**
 * The devices pointing at a room.
 *
 * What an interface asks *before* offering to delete one, to decide whether it has to make
 * anybody choose anything. A query, so it reports rather than refusing.
 *
 * Disabled devices count. A device somebody switched off is still a device in a room, and a
 * deletion that quietly stranded it would be found by whoever switched it back on.
 */
export function devicesInRoom(
  roomId: string,
  devices: readonly DeviceDocument[],
): readonly DeviceDocument[] {
  return devices.filter((device) => device.roomId === roomId)
}

/**
 * Works out everything deleting a room does.
 *
 * @param roomId the room to delete
 * @param rooms the project's rooms
 * @param devices the project's devices
 * @param destination where the devices in that room go — **required even when there are none**,
 *   which is how "a room with devices cannot be silently deleted" is enforced rather than
 *   remembered
 * @param uuid the uuid source, used only when `Unassigned` has to be created
 * @throws {RangeError} If the room is not here, if the destination is not here, or if the
 *   destination is the room being deleted — which reads as a no-op and is not one: the room
 *   goes, and every device in it then points at a document that does not exist.
 */
export function planRoomDeletion(
  roomId: string,
  rooms: readonly RoomDocument[],
  devices: readonly DeviceDocument[],
  destination: RoomDestination,
  uuid: () => string,
): RoomDeletionPlan {
  const remove = rooms.find((entry) => entry._id === roomId)
  if (remove === undefined) {
    throw new RangeError(`Cannot delete ${JSON.stringify(roomId)}; it is not a room here.`)
  }

  const stranded = devicesInRoom(roomId, devices)

  if (destination.kind === 'room') {
    if (destination.roomId === roomId) {
      throw new RangeError(
        'Devices cannot be moved into the room being deleted; choose another room or Unassigned.',
      )
    }
    if (!rooms.some((entry) => entry._id === destination.roomId)) {
      throw new RangeError(
        `Cannot move devices to ${JSON.stringify(destination.roomId)}; it is not a room here.`,
      )
    }
  }

  // Nothing to move means nothing to create either — a project that has never needed an
  // `Unassigned` room should not acquire an empty one from a deletion that stranded nobody.
  if (stranded.length === 0) return { remove, reassign: [] }

  const target =
    destination.kind === 'room'
      ? { roomId: destination.roomId }
      : // Through `chooseRoom` rather than a search of its own, so "is this room already here"
        // has one answer across the whole application — by key, so an existing `unassigned`
        // is not joined by a second `Unassigned`.
        chooseRoom(UNASSIGNED_ROOM_PREFIX, rooms, uuid)

  const reassign = stranded.map((device) => {
    const { updatedAt: _stamp, ...rest } = device
    return { ...rest, roomId: target.roomId }
  })

  return {
    remove,
    reassign,
    ...(destination.kind === 'room' || target.room === undefined ? {} : { create: target.room }),
  }
}
