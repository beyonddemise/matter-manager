/**
 * Room paths: the materialised-path hierarchy from ADR 0006, carried on each device (ADR 0021).
 *
 * A room's name *is* its position — `Ground Floor/Kitchen`. Hierarchy is derived by splitting
 * the string, which buys grouping, filtering and PDF sectioning with no tree to maintain and,
 * more importantly, no reparenting conflicts under offline sync.
 *
 * **A room is identified by its {@link roomPathKey}, not by its exact text.** Each device stores
 * the path it was saved with, so one room can turn up spelled `Kitchen` on one device and
 * `kitchen` on another. Every question about rooms here (is this inside that, what does a rename
 * touch) compares keys, so the spellings stay one room until somebody merges them.
 *
 * Two conventions run through this module, and they are deliberate opposites:
 *
 * **Queries report, transformations throw.** {@link roomPathProblem} answers a question and
 * returns a reason the interface can translate; {@link renameRoomPath} performs an operation
 * with a precondition and refuses when it is not met. The alternative to refusing is writing a
 * structurally broken path into the database and discovering it much later.
 *
 * **Normalising tidies presentation; it never repairs structure.** Whitespace around a segment
 * is noise and gets trimmed. An empty segment is a different path, and is preserved so the
 * validator can see it. Silently collapsing `Floor//Kitchen` would hand back a room the user
 * never typed while reporting success.
 *
 * @module
 */

import { foldForComparison } from '../text/fold.js'

/** Segments are separated by `/`. Chosen over `.` in ADR 0006, which collides with `No. 2`. */
export const ROOM_PATH_SEPARATOR = '/'

/** Why a room path cannot be used. A code rather than a sentence, so the interface can translate it. */
export type RoomPathProblem =
  /** Nothing but whitespace. */
  | 'empty'
  /** A `//`, a leading or trailing separator, or a segment of only whitespace. */
  | 'emptySegment'

/** Thrown when an operation is asked to work from or towards an unusable path. */
export class RoomPathError extends Error {
  override readonly name = 'RoomPathError'
}

/**
 * Splits a path into its segments.
 *
 * Empty segments are kept. Discarding them here would make `Floor//Kitchen` indistinguishable
 * from `Floor/Kitchen`, and {@link roomPathProblem} would have nothing left to object to.
 */
export function splitRoomPath(path: string): readonly string[] {
  return path.split(ROOM_PATH_SEPARATOR)
}

/**
 * Trims whitespace around each segment, leaving everything else alone.
 *
 * Case is preserved: how a user capitalises their own house is not this module's decision.
 * Whitespace *inside* a segment is preserved too — only the edges are noise. That two spellings
 * are the same room is {@link roomPathKey}'s business, not this function's.
 */
export function normaliseRoomPath(path: string): string {
  return splitRoomPath(path)
    .map((segment) => segment.trim())
    .join(ROOM_PATH_SEPARATOR)
}

/**
 * Reports why a path cannot be used as a room path, or `null` when it can.
 *
 * `empty` and `emptySegment` are kept apart because they call for different remedies: one
 * means "type something", the other means "you have a stray slash". A single `invalid` would
 * tell the user neither.
 */
export function roomPathProblem(path: string): RoomPathProblem | null {
  const normalised = normaliseRoomPath(path)
  if (normalised === '') return 'empty'
  if (splitRoomPath(normalised).some((segment) => segment === '')) return 'emptySegment'
  return null
}

/** Whether a path is usable as a room path. See {@link roomPathProblem}. */
export function isValidRoomPath(path: string): boolean {
  return roomPathProblem(path) === null
}

/**
 * The key that identifies a room: `Ground Floor/Kitchen` and `ground floor/kitchen` share one.
 *
 * Each segment is folded by {@link foldForComparison}, which is where the reasoning about case,
 * whitespace and Unicode lives - it is shared with device search, so "the same room" and
 * "matches what I typed" cannot drift apart.
 *
 * Segment by segment rather than over the whole path, so the separator is never folded and a
 * path can still be split back apart afterwards.
 *
 * The folding is deliberately aggressive. Two spellings a person would read as one room are one
 * room (ADR 0021); the Rooms page lists both and offers to merge them.
 */
export function roomPathKey(path: string): string {
  return splitRoomPath(normaliseRoomPath(path)).map(foldForComparison).join(ROOM_PATH_SEPARATOR)
}

/** Whether two paths name the same room. See {@link roomPathKey}. */
export function isSameRoom(a: string, b: string): boolean {
  return roomPathKey(a) === roomPathKey(b)
}

/**
 * Whether `path` is `root` or lives inside it.
 *
 * **Matching is on segment boundaries, not string prefixes**, and that distinction is the whole
 * reason this is a function rather than a `startsWith`: `Floor 10/Kitchen` starts with
 * `Floor 1` and is not in it. Get it wrong when renaming and a room moves into a building it
 * was never in; get it wrong when exporting and a PDF quietly contains rooms nobody asked for
 * — which is worse, because it is handed to someone else.
 *
 * Compared by {@link roomPathKey}, so `kitchen/Pantry` is within `Kitchen`: the spellings are one
 * room, and a filter or export that dropped some of them would drop devices.
 */
export function isWithinRoom(path: string, root: string): boolean {
  const current = roomPathKey(path)
  const ancestor = roomPathKey(root)
  return current === ancestor || current.startsWith(ancestor + ROOM_PATH_SEPARATOR)
}

/**
 * Orders two room paths so that every room is followed directly by the rooms inside it.
 *
 * **Segment by segment, not as one string** (#242). Compared whole, a space (0x20) sorts
 * before the separator (0x2F), so `Attic Bedroom` lands between `Attic` and `Attic/Studio` and
 * the attic is split in two by a room that has nothing to do with it. A locale collator does
 * not help either: it ignores punctuation differently in every locale, which is no rule at all.
 * Comparing segments makes the hierarchy, not the alphabet, decide where a sub-room goes.
 *
 * When one path is a prefix of the other, the shorter (the parent) comes first.
 *
 * @param a one room path
 * @param b the other
 * @param compare how two segments order; the caller's locale collator, so `Ärmel` sits beside
 *   `Armel` in German. Kept as a parameter because this module holds no ambient locale.
 * @returns negative when `a` comes first, positive when `b` does, zero when they are equal
 */
export function compareRoomPaths(
  a: string,
  b: string,
  compare: (left: string, right: string) => number,
): number {
  const left = splitRoomPath(a)
  const right = splitRoomPath(b)
  const shared = Math.min(left.length, right.length)
  for (let index = 0; index < shared; index++) {
    const order = compare(left[index] as string, right[index] as string)
    if (order !== 0) return order
  }
  return left.length - right.length
}

/**
 * What goes between segments when a path is shown as a breadcrumb: `Attic › Studio`.
 *
 * A typographic angle rather than the `/` the path is stored with, because a heading reads as a
 * place, not as a file name. It is in WinAnsi (0x9B), so the inventory PDF can draw it with the
 * standard fonts.
 */
export const ROOM_PATH_CRUMB = ' › '

/**
 * A room path written as a breadcrumb, for places that can only show plain text (the PDF).
 *
 * The device list builds the same thing from {@link splitRoomPath} so it can style each
 * segment; this is the plain-text twin, and the separator is shared so the two cannot drift.
 */
export function roomPathBreadcrumb(path: string): string {
  return splitRoomPath(path).join(ROOM_PATH_CRUMB)
}

/** Normalises a path for use as an endpoint of a rename, refusing anything unusable. */
function requireUsable(path: string, role: string): string {
  const problem = roomPathProblem(path)
  if (problem !== null) {
    throw new RoomPathError(
      `The ${role} of a rename is not a usable room path (${problem}): a path is one or more non-empty segments separated by "${ROOM_PATH_SEPARATOR}".`,
    )
  }
  return normaliseRoomPath(path)
}

/**
 * Returns what `path` becomes when the room at `from` is renamed to `to`.
 *
 * Renames the room itself and every descendant, and leaves everything else untouched. The
 * caller maps this over the devices; moving a subtree is a loop over the paths rather than a
 * single write.
 *
 * **Matching is on segment boundaries, not string prefixes.** A `startsWith` check would
 * rewrite `Floor 10/Kitchen` when `Floor 1` is renamed, moving a room into a building it was
 * never in, with nothing about the result looking wrong afterwards.
 *
 * Matching is by {@link roomPathKey}, so renaming `Kitchen` also rewrites a device that says
 * `kitchen/Pantry`, to `<to>/Pantry`. That is what makes a rename a merge of every spelling.
 *
 * @param path The path to rewrite. Returned normalised; it need not be valid, so a broken room
 *   list can still be repaired by renaming around it.
 * @param from The path being renamed.
 * @param to Its new path, which may be deeper or shallower than the old one.
 * @throws {RoomPathError} If `from` or `to` is not a usable room path.
 */
export function renameRoomPath(path: string, from: string, to: string): string {
  const source = requireUsable(from, 'source')
  const target = requireUsable(to, 'target')
  const current = normaliseRoomPath(path)

  // Through `isWithinRoom` rather than a second `startsWith` here, so the segment-boundary
  // rule described above has exactly one implementation. Two would be two chances to get
  // `Floor 10` versus `Floor 1` wrong, in two features, at different times.
  if (!isWithinRoom(current, source)) return current
  // The matched ancestor is replaced by segment count, not by string length: its spelling here
  // may differ from `source`, and folding can change a string's length.
  const rest = splitRoomPath(current).slice(splitRoomPath(source).length)
  return [target, ...rest].join(ROOM_PATH_SEPARATOR)
}
