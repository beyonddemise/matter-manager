/**
 * Which devices an export covers.
 *
 * A closed union rather than a bag of optional filters, because the three answers are genuinely
 * different questions and a caller should not be able to ask two at once. "Everything on
 * screen", "these ones I ticked" and "this room" have different failure modes and different
 * things a user would be surprised by.
 *
 * What this does **not** decide is whether disabled devices are in scope. `browseDevices`
 * already answered that, for the screen, and the export receives its answer — so a device the
 * user cannot see cannot appear in a PDF they hand to someone else. That is the acceptance
 * criterion "disabled devices are excluded unless explicitly included", satisfied by not having
 * a second opinion rather than by implementing one.
 *
 * @module
 */

import type { DeviceGroup } from '../documents/browse.js'
import { isWithinRoom } from '../rooms/path.js'

/** What to export. */
export type ExportSelection =
  /** Everything the caller passed in. */
  | { readonly kind: 'all' }
  /** Only these device ids. Full `device:<uuid>` ids, as stored. */
  | { readonly kind: 'devices'; readonly ids: ReadonlySet<string> }
  /** A room and everything below it. */
  | { readonly kind: 'room'; readonly path: string }

/**
 * Narrows the groups to the selection.
 *
 * Groups left with nothing in them are dropped rather than kept empty: a PDF of a single room
 * that also lists every other room in the house as a heading with nothing under it is a
 * document that has misunderstood the request.
 *
 * The order of what survives is the order it arrived in. Selection is a filter, and a filter
 * that reorders is a filter someone has to check twice.
 */
export function selectForExport(
  groups: readonly DeviceGroup[],
  selection: ExportSelection,
): readonly DeviceGroup[] {
  if (selection.kind === 'all') return groups

  const keep =
    selection.kind === 'devices'
      ? (group: DeviceGroup) => group.devices.filter((device) => selection.ids.has(device._id))
      : // A room *and its sub-rooms*, matched on segment boundaries. `Floor 1` must not take
        // `Floor 10/Kitchen` with it — see `isWithinRoom`, which is also what renaming uses, so
        // there is one implementation of that rule rather than two chances to get it wrong.
        //
        // The `path !== ''` guard is not redundant, and the case it covers is the one worth
        // stating: an empty *selection* path would otherwise match the empty *group* path, so
        // `{ kind: 'room', path: '' }` would export precisely the devices whose room is gone.
        // An empty string is what an uninitialised variable looks like rather than what a
        // request looks like — the interface offers no such export — and the permissive
        // reading turns a bug elsewhere into a PDF of devices nobody asked about, handed to
        // someone else.
        (group: DeviceGroup) =>
          group.path !== '' && isWithinRoom(group.path, selection.path) ? group.devices : []

  return groups
    .map((group) => ({ ...group, devices: keep(group) }))
    .filter((group) => group.devices.length > 0)
}

/** How many devices a selection would export. For a button that says what it will do. */
export function countSelected(groups: readonly DeviceGroup[], selection: ExportSelection): number {
  return selectForExport(groups, selection).reduce(
    (count, group) => count + group.devices.length,
    0,
  )
}
