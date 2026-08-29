/**
 * Room paths: the materialised-path hierarchy from ADR 0006.
 *
 * A room's name *is* its position — `Ground Floor/Kitchen`. Hierarchy is derived by splitting
 * the string, which buys grouping, filtering and PDF sectioning with no tree to maintain and,
 * more importantly, no reparenting conflicts under offline sync.
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

/**
 * The room a device ends up in when it has nowhere else to be.
 *
 * Lives here rather than beside either of its users. `sync/merge.ts` resurrects a deleted room
 * beneath it, and `rooms/list.ts` moves devices into it when their room is deleted — two
 * features, arriving at different milestones, that must name the same room. A second constant
 * with the same value would be two rooms the day somebody changed one of them.
 */
export const UNASSIGNED_ROOM_PREFIX = 'Unassigned'

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
 * Case is preserved: how a user capitalises their own house is not this module's decision, and
 * ADR 0006 treats `Ground Floor` and `ground floor` as genuinely different rooms. Whitespace
 * *inside* a segment is preserved too — only the edges are noise.
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
 * The key under which two paths count as the same room to a human reading them.
 *
 * ADR 0006 accepts that `Ground Floor/Kitchen` and `ground floor/Kitchen` are different rooms,
 * and asks for a warning at creation time so nobody makes the second one by accident. This is
 * that comparison: each segment folded by {@link foldForComparison}, which is where the reasoning
 * about case, whitespace and Unicode now lives - it is shared with device search, so "the same
 * room" and "matches what I typed" cannot drift apart.
 *
 * Segment by segment rather than over the whole path, so the separator is never folded and a
 * path can still be split back apart afterwards.
 *
 * The folding is deliberately more aggressive than the comparison strictly needs. This drives
 * a *warning*, not a rejection, so an extra prompt costs a moment and a missed one costs a
 * duplicate room nobody can tell apart afterwards.
 */
export function roomPathKey(path: string): string {
  return splitRoomPath(normaliseRoomPath(path)).map(foldForComparison).join(ROOM_PATH_SEPARATOR)
}

/** Whether two paths differ only in ways a person would not notice. See {@link roomPathKey}. */
export function isNearDuplicateRoomPath(a: string, b: string): boolean {
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
 * Case-sensitive, because ADR 0006 makes case distinguish rooms. Use
 * {@link isNearDuplicateRoomPath} to warn about a confusable pair at creation time instead.
 *
 * Both paths are normalised first, so a trailing separator or doubled spacing on either side
 * does not change the answer.
 */
export function isWithinRoom(path: string, root: string): boolean {
  const current = normaliseRoomPath(path)
  const ancestor = normaliseRoomPath(root)
  return current === ancestor || current.startsWith(ancestor + ROOM_PATH_SEPARATOR)
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
 * caller maps this over the room list; ADR 0006 notes that moving a subtree is a loop over the
 * paths rather than a single write.
 *
 * **Matching is on segment boundaries, not string prefixes.** A `startsWith` check would
 * rewrite `Floor 10/Kitchen` when `Floor 1` is renamed, moving a room into a building it was
 * never in, with nothing about the result looking wrong afterwards.
 *
 * Matching is case-sensitive, because ADR 0006 makes case distinguish rooms; renaming
 * `Floor 1` must not take `floor 1` with it. Use {@link isNearDuplicateRoomPath} to warn about
 * that pair at creation time instead.
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
  return current === source ? target : target + current.slice(source.length)
}
