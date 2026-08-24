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
 * that comparison: case folded, runs of whitespace collapsed, and Unicode composed.
 *
 * The Unicode step matters more than it looks. `ü` has two spellings — one code point, or `u`
 * followed by a combining diaeresis — which render identically. In a German-speaking house,
 * typing one and pasting the other would otherwise produce two rooms nobody can tell apart on
 * screen. Composing happens last, because case folding can decompose.
 *
 * Case is *folded*, not merely lowered. `toLowerCase` implements Unicode case **conversion**,
 * which preserves linguistic distinctions on purpose; folding erases them so two spellings of
 * one word compare equal. The difference is not academic here: `Straße`.toLowerCase() is
 * `straße` and `STRASSE`.toLowerCase() is `strasse`, so the same German room would fail to be
 * recognised as a duplicate of itself. Upper-casing collapses `ß` to `SS`, the Greek final
 * sigma to the medial form, and ligatures to their letters.
 *
 * Upper rather than lower, and nothing after it: lowering the result again was measured to
 * change no comparison, so it was removed. The key is never displayed - it exists only to be
 * equal or not.
 *
 * The folding is deliberately more aggressive than the comparison strictly needs. This drives
 * a *warning*, not a rejection, so an extra prompt costs a moment and a missed one costs a
 * duplicate room nobody can tell apart afterwards.
 */
export function roomPathKey(path: string): string {
  return splitRoomPath(normaliseRoomPath(path))
    .map((segment) => segment.replace(/\s+/g, ' ').toUpperCase().normalize('NFC'))
    .join(ROOM_PATH_SEPARATOR)
}

/** Whether two paths differ only in ways a person would not notice. See {@link roomPathKey}. */
export function isNearDuplicateRoomPath(a: string, b: string): boolean {
  return roomPathKey(a) === roomPathKey(b)
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

  if (current === source) return target
  if (current.startsWith(source + ROOM_PATH_SEPARATOR)) {
    return target + current.slice(source.length)
  }
  return current
}
