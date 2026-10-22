/**
 * The rooms a project has, derived from its devices, and renaming one (ADR 0021).
 *
 * There is no room document. A device carries its room's path, so the rooms that exist are
 * exactly the paths the devices carry, and this module works them out. A room appears when the
 * first device is filed under it and is gone when the last one leaves; nothing has to be kept in
 * step with anything.
 *
 * `path.ts` answers questions about one path. This is the layer above: the whole list, and what
 * a rename does to the devices in it. Like `documents/`, it **plans and does not write**, and a
 * rename returns only the devices that change, because on a shared project each document
 * rewritten is a document somebody else's phone downloads.
 *
 * @module
 */

import type { DeviceDocument, Unsaved } from '../documents/types.js'
import { compareRoomPaths, renameRoomPath, roomPathKey } from './path.js'

/** One room, as the Rooms page lists it. */
export interface Room {
  /** The {@link roomPathKey} every spelling shares. Stable across spellings and replicas. */
  readonly key: string
  /**
   * Every distinct path the devices in this room carry, in {@link compareRoomPaths} order.
   *
   * Usually one. More than one when two people typed the room differently before their devices
   * synced (`Kitchen` and `kitchen`). None is chosen as the room's real name: the page shows
   * them all and offers a merge, so nobody's spelling quietly wins.
   */
  readonly spellings: readonly [string, ...string[]]
  /** Devices filed exactly here, disabled ones included. Sub-rooms count separately. */
  readonly deviceCount: number
}

/** Compares two strings by code point, returning the usual negative, zero or positive. */
const compareText = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0)

/**
 * The rooms the devices are in, sorted by path.
 *
 * Disabled devices count: a device somebody switched off is still in a room, and a room that
 * vanished from the list while its only device was out of service would be a rename nobody can
 * reach. A device with no usable path (an empty or missing `room`) belongs to no room.
 *
 * @param devices every device in the project
 * @param compare how two path segments order. Defaults to code-point order; the web layer passes
 *   its locale collator so the list sorts as the device list does.
 */
export function roomsOf(
  devices: readonly DeviceDocument[],
  compare: (a: string, b: string) => number = compareText,
): readonly Room[] {
  const byKey = new Map<string, { spellings: Set<string>; deviceCount: number }>()
  for (const device of devices) {
    // `?? ''`: a document written before ADR 0021 has `roomId` and no `room`. No repair is
    // made (ADR 0021), but it must not crash the page that lists rooms.
    const path = device.room ?? ''
    const key = roomPathKey(path)
    if (key === '') continue
    const entry = byKey.get(key)
    if (entry === undefined) byKey.set(key, { spellings: new Set([path]), deviceCount: 1 })
    else {
      entry.spellings.add(path)
      entry.deviceCount++
    }
  }

  // Code point breaks a tie, so spellings the collator calls equal (a composed and a decomposed
  // `Küche`) still come out in one order on every replica, whatever order the devices came in.
  const byPath = (a: string, b: string): number =>
    compareRoomPaths(a, b, compare) || compareText(a, b)
  return [...byKey]
    .map(([key, { spellings, deviceCount }]) => ({
      key,
      spellings: [...spellings].sort(byPath) as [string, ...string[]],
      deviceCount,
    }))
    .sort((a, b) => byPath(a.spellings[0], b.spellings[0]))
}

/**
 * Renames a room and everything inside it, returning only the devices that change.
 *
 * Every spelling of `from`, and of every room inside it, is rewritten (see `renameRoomPath`), so
 * renaming is also how two spellings are merged into one. Renaming onto a room that already
 * exists simply files these devices there too; that is a merge, and it needs no special case
 * because a room is nothing but the devices in it.
 *
 * Safe to repeat after a partial failure: a device already renamed is no longer inside `from`,
 * so it is not matched a second time. The exception is a rename into the room's own subtree
 * (`Kitchen` to `Kitchen/Old`), where a repeat nests once more; the caller re-reads the devices
 * before retrying, which is what makes that case safe too.
 *
 * @param devices every device in the project
 * @param from any spelling of the room to rename
 * @param to its new path, which may be deeper or shallower than the old one
 * @throws {RoomPathError} If `from` or `to` is not a usable room path.
 */
export function renameRoom(
  devices: readonly DeviceDocument[],
  from: string,
  to: string,
): readonly Unsaved<DeviceDocument>[] {
  return devices.flatMap((device) => {
    const path = device.room ?? ''
    if (path === '') return []
    const renamed = renameRoomPath(path, from, to)
    if (renamed === path) return []
    // `updatedAt` dropped rather than carried: the repository owns the stamp, and it is half of
    // the total order the conflict merge depends on (ADR 0010).
    const { updatedAt: _stamp, ...rest } = device
    return [{ ...rest, room: renamed }]
  })
}
