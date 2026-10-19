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

import { manufacturerName, TEST_VENDOR_NAME } from '../catalog/copy.js'
import { compareRoomPaths, isWithinRoom, roomPathKey } from '../rooms/path.js'
import { foldForComparison } from '../text/fold.js'
import type { DeviceDocument } from './types.js'

/** One room and the devices in it, as the list renders them. */
export interface DeviceGroup {
  /** The room's `roomPathKey`, or `''` for devices with no room. Unique within one browse. */
  readonly key: string
  /**
   * The room's first spelling, or `''` for devices with no room. See {@link browseDevices}.
   *
   * What a heading's breadcrumb and an export selection are built from. Any spelling would do
   * for the selection, since rooms are matched by key.
   */
  readonly path: string
  /** Every spelling the devices here carry, in path order; empty for devices with no room. */
  readonly spellings: readonly string[]
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
   * Only the devices in this room and the rooms inside it (`isWithinRoom`, so any spelling).
   *
   * The filter the Rooms page links to. Combines with `query`: both must match.
   */
  readonly room?: string
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
  /**
   * The test vendor's name in the interface language, e.g. `Testhersteller`.
   *
   * The stored name is always English (`TEST_VENDOR_NAME`), but the interface shows it
   * translated, so a person searches for what they see. Passed in rather than looked up because
   * `core` holds no `msg()` and no ambient locale. A device whose manufacturer is the test vendor
   * also matches this term; the stored English name keeps matching too.
   */
  readonly testVendorTerm?: string
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
 * Name, room, serial and product name, plus `spot`, `vendorName`, `vendorPreferredName` and
 * `partNumber`: "ceiling", "the Ikea one" and "AS056" are all how people describe a device they
 * are looking for, and no such match is ever surprising. The test vendor's shown name
 * (`testVendorTerm`, #248) joins them for a device whose manufacturer is the test vendor.
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
function haystack(device: DeviceDocument, path: string, testVendorTerm?: string): string {
  const shownTestVendor = manufacturerName(device) === TEST_VENDOR_NAME ? testVendorTerm : undefined
  return [
    device.name,
    path,
    device.spot,
    device.serial,
    device.productName,
    device.vendorName,
    device.vendorPreferredName,
    device.partNumber,
    shownTestVendor,
  ]
    .filter((value): value is string => value !== undefined && value !== '')
    .map(foldForComparison)
    .join('\n')
}

/**
 * Groups devices by room, optionally searched and filtered.
 *
 * Grouped by `roomPathKey`, so `Kitchen` and `kitchen` are one group listing both spellings.
 *
 * A device with no room (an empty or missing `room`, which only a document from before ADR 0021
 * can have) is not dropped — it is grouped under `''` and sorted last. Losing sight of a device
 * is the failure this application exists to prevent.
 *
 * Groups with no devices are not produced. A search for "kitchen" that listed every empty room
 * in the house would bury the two results it found.
 *
 * @param devices every device in the project
 * @param options see {@link BrowseOptions}
 * @returns rooms in path order (parents before their sub-rooms; see `compareRoomPaths`), each
 *   with its devices in name order
 */
export function browseDevices(
  devices: readonly DeviceDocument[],
  options: BrowseOptions = {},
): readonly DeviceGroup[] {
  const compare = options.compare ?? foldedOrder
  const byPath = (a: string, b: string): number => compareRoomPaths(a, b, compare)
  const { room } = options

  // Every term must match, so "kitchen light" finds the light in the kitchen rather than
  // everything in the kitchen plus every light in the house. Folded once, here, rather than
  // per device.
  const terms = foldForComparison(options.query ?? '')
    .split(' ')
    .filter((term) => term !== '')

  const visible = devices.filter((device) => {
    if (device.disabled && options.includeDisabled !== true) return false
    // `?? ''` throughout: a document from before ADR 0021 has no `room` (no repair is made).
    const path = device.room ?? ''
    if (room !== undefined && (path === '' || !isWithinRoom(path, room))) return false
    if (terms.length === 0) return true
    const text = haystack(device, path, options.testVendorTerm)
    return terms.every((term) => text.includes(term))
  })

  const grouped = new Map<string, DeviceDocument[]>()
  for (const device of visible) {
    const key = roomPathKey(device.room ?? '')
    const group = grouped.get(key)
    if (group === undefined) grouped.set(key, [device])
    else group.push(device)
  }

  const groups = [...grouped].map(([key, members]) => {
    const spellings =
      key === '' ? [] : [...new Set(members.map((device) => device.room))].sort(byPath)
    return {
      key,
      path: spellings[0] ?? '',
      spellings,
      devices: [...members].sort((a, b) => compare(a.name, b.name)),
    }
  })

  // Rooms in path order, then the homeless. Sorting `''` in with the rest would put it first,
  // which is the one place a group nobody chose should not be.
  //
  // Path order is segment by segment (#242), so `Attic/Studio` follows `Attic` directly rather
  // than after `Attic Bedroom`. The groups stay flat: a parent with no devices of its own gets
  // no group, and the view's breadcrumb heading is what shows the lineage.
  const named = groups.filter((group) => group.path !== '')
  const unplaced = groups.filter((group) => group.path === '')
  named.sort((a, b) => byPath(a.path, b.path))
  return [...named, ...unplaced]
}
