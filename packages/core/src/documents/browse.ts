/**
 * Turning a flat list of devices into the thing a person actually reads: rooms, in order, with
 * what they contain.
 *
 * Grouping, searching and filtering are decisions over plain data, so they live here rather
 * than in the view. That is not tidiness — it is what makes "search matches the room path"
 * testable in a millisecond with no DOM, and it is the same split that `planNewDevice` uses.
 * The view's job is left as rendering what this returns.
 *
 * @module
 */

import { foldForComparison } from '../text/fold.js'
import type { DeviceDocument, RoomDocument } from './types.js'

/** One room and the devices in it, as the list renders them. */
export interface DeviceGroup {
  readonly roomId: string
  /** The room's path, or `''` when no room with that id exists. See {@link browseDevices}. */
  readonly path: string
  /** Never empty: a group with nothing in it is not produced. */
  readonly devices: readonly DeviceDocument[]
}

/** How to browse. Every field is optional; the default is "everything, grouped, unsearched". */
export interface BrowseOptions {
  /** Free text. Whitespace-separated terms, all of which must match somewhere. */
  readonly query?: string
  /** Disabled devices are left out unless this is `true`. */
  readonly includeDisabled?: boolean
  /**
   * How two display strings order.
   *
   * The seam exists because ordering is the one part of this that is genuinely
   * locale-dependent, and `core` holds no ambient locale: `localeCompare` with no argument
   * reads one from the environment, which is exactly the ambient dependency this package
   * refuses. The default is deterministic and good enough for ASCII; the web layer passes an
   * `Intl.Collator` for the locale it is already rendering in, which is what puts `Ärmel`
   * beside `Armel` in German rather than after `Zulu`.
   */
  readonly compare?: (a: string, b: string) => number
}

/** Ordering for the default {@link BrowseOptions.compare}: folded, then by code point. */
function foldedOrder(a: string, b: string): number {
  const left = foldForComparison(a)
  const right = foldForComparison(b)
  if (left < right) return -1
  return left > right ? 1 : 0
}

/**
 * Everything about a device a search may look at, folded and joined.
 *
 * The issue names name, room, serial and product. `spot` and `vendorName` are here too:
 * "ceiling" and "the Ikea one" are both how people describe a device they are looking for, and
 * neither match is ever surprising.
 *
 * `payload` and `manualCode` are **deliberately absent, and this is a security decision**.
 * They encode the setup passcode. A search box that matched them would confirm a guess — type
 * digits, see whether a device lights up — turning a list into an oracle for the one secret
 * this application holds.
 *
 * Joined on a newline rather than a space or a `/`, because a folded query can never contain
 * one: `foldForComparison` collapses every run of whitespace to a single space. That is what
 * stops a term from matching across two fields and reporting a device that contains neither.
 */
function haystack(device: DeviceDocument, path: string): string {
  return [device.name, path, device.spot, device.serial, device.productName, device.vendorName]
    .filter((value): value is string => value !== undefined && value !== '')
    .map(foldForComparison)
    .join('\n')
}

/**
 * Groups devices by room, optionally searched and filtered.
 *
 * A device whose `roomId` names no existing room is not dropped — it is grouped under `''` and
 * sorted last, so a room deleted on another replica leaves its devices visible rather than
 * invisible. Losing sight of a device is the failure this application exists to prevent.
 *
 * Groups with no devices are not produced. A search for "kitchen" that listed every empty room
 * in the house would bury the two results it found.
 *
 * @param devices every device in the project
 * @param rooms every room, used to resolve paths and to search on them
 * @param options see {@link BrowseOptions}
 * @returns rooms in path order, each with its devices in name order
 */
export function browseDevices(
  devices: readonly DeviceDocument[],
  rooms: readonly RoomDocument[],
  options: BrowseOptions = {},
): readonly DeviceGroup[] {
  const compare = options.compare ?? foldedOrder
  const paths = new Map(rooms.map((room) => [room._id, room.path]))

  // Every term must match, so "kitchen light" finds the light in the kitchen rather than
  // everything in the kitchen plus every light in the house. Folded once, here, rather than
  // per device.
  const terms = foldForComparison(options.query ?? '')
    .split(' ')
    .filter((term) => term !== '')

  const visible = devices.filter((device) => {
    if (device.disabled && options.includeDisabled !== true) return false
    if (terms.length === 0) return true
    const text = haystack(device, paths.get(device.roomId) ?? '')
    return terms.every((term) => text.includes(term))
  })

  const grouped = new Map<string, DeviceDocument[]>()
  for (const device of visible) {
    const group = grouped.get(device.roomId)
    if (group === undefined) grouped.set(device.roomId, [device])
    else group.push(device)
  }

  const groups = [...grouped].map(([roomId, members]) => ({
    roomId,
    path: paths.get(roomId) ?? '',
    devices: [...members].sort((a, b) => compare(a.name, b.name)),
  }))

  // Rooms in path order, then the homeless. Sorting `''` in with the rest would put it first,
  // which is the one place a group nobody chose should not be.
  const named = groups.filter((group) => group.path !== '')
  const unplaced = groups.filter((group) => group.path === '')
  named.sort((a, b) => compare(a.path, b.path))
  return [...named, ...unplaced]
}
