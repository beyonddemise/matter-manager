/**
 * Recognising PouchDB's error shapes.
 *
 * @module
 */

/**
 * Whether an error, or a `bulkDocs` row, is PouchDB reporting a lost revision race.
 *
 * Both forms count: `put` rejects with `status: 409`, while a failed `bulkDocs` row may carry
 * only `name: 'conflict'`. There used to be three copies of this test, and the ones that looked
 * only at the status would have missed the second form (#238).
 *
 * @param error anything thrown or returned; non-objects are never conflicts
 * @returns true for a 409 or a conflict-named row
 */
export function isConflict(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    ((error as { status?: unknown }).status === 409 ||
      (error as { name?: unknown }).name === 'conflict')
  )
}
