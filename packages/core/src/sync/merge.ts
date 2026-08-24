/**
 * Conflict merge strategies (ADR 0010).
 *
 * CouchDB detects conflicts and picks a winner, but it does not merge: the losing revision
 * stays in the tree where nothing surfaces it. For an embedded array like `remarks`, that
 * means a remark someone wrote offline **silently disappears from the interface**. Nobody
 * notices, so nobody reports it, and trust in the record erodes with no identifiable cause.
 *
 * These functions take `(winner, conflicts[])` and return the merged document. They are pure,
 * and that is a correctness requirement rather than a style preference.
 *
 * **Every ordering here is a pair whose second element is unique.** "Last write wins by
 * `updatedAt`" is not a total order — offline clients produce equal timestamps routinely, and
 * their clocks disagree. An ordering with undefined ties lets each replica pick a different
 * winner, and then the replicas **never converge**: each is internally consistent, they
 * disagree permanently, and no amount of further replication repairs it. That is strictly
 * worse than picking the "wrong" winner, because there is no longer a single answer to
 * converge on. Scalars order by `(updatedAt, _rev)`, remarks by `(createdAt, id)`.
 *
 * **Nothing outside the documents may be consulted.** Not the clock, not arrival order, not
 * which replica is running. Every replica must compute the same result independently, with no
 * coordination — so the result must be a function of the set of revisions alone, including
 * which one CouchDB happened to label the winner.
 *
 * @module
 */

import { normaliseRoomPath, ROOM_PATH_SEPARATOR, splitRoomPath } from '../rooms/path.js'

/** A remark on a device. Embedded in the device document, per ADR 0010. */
export interface Remark {
  /** A client-generated UUID. Positional identity would make "the same remark twice" and "two different remarks" indistinguishable. */
  readonly id: string
  readonly text: string
  readonly authorSub: string
  readonly authorName: string
  readonly createdAt: string
}

/** What the merge needs from any conflicting document. */
export interface Revision {
  readonly _id: string
  readonly _rev: string
  /** ISO-8601 UTC, which sorts chronologically as a string. */
  readonly updatedAt: string
}

/** A revision carrying embedded remarks. */
export interface RemarkBearing extends Revision {
  readonly remarks?: readonly Remark[]
}

/** A revision of a room document. */
export interface RoomRevision extends Revision {
  readonly path?: string
  readonly _deleted?: boolean
}

/** Where a room goes when it is deleted but devices still point at it. */
export const UNASSIGNED_ROOM_PREFIX = 'Unassigned'

/** Splits `generation-hash`, tolerating a malformed revision rather than throwing in a comparator. */
function parseRevision(rev: string): { readonly generation: number; readonly hash: string } {
  const separator = rev.indexOf('-')
  if (separator < 0) return { generation: 0, hash: rev }
  const generation = Number(rev.slice(0, separator))
  return {
    generation: Number.isFinite(generation) ? generation : 0,
    hash: rev.slice(separator + 1),
  }
}

/** Compares two strings, returning the usual negative, zero or positive. */
const compareText = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0)

/**
 * Orders CouchDB revision ids: generation first, then hash.
 *
 * The generation is compared **numerically**. Comparing whole revision ids as strings is wrong
 * in a way that looks right — `'10-aaa' < '9-zzz'` lexicographically, so generation 10 would
 * lose to generation 9 and the newer write would be thrown away.
 */
export function compareRevisions(a: string, b: string): number {
  const left = parseRevision(a)
  const right = parseRevision(b)
  return left.generation !== right.generation
    ? left.generation - right.generation
    : compareText(left.hash, right.hash)
}

/** Orders revisions by `(updatedAt, _rev)` — the total order ADR 0010 requires for scalars. */
function compareForWinner(a: Revision, b: Revision): number {
  const byTime = compareText(a.updatedAt, b.updatedAt)
  return byTime !== 0 ? byTime : compareRevisions(a._rev, b._rev)
}

/**
 * The revision whose scalar fields win.
 *
 * @throws {RangeError} If given no revisions; there is no document to return and inventing one
 *   would be worse than failing loudly.
 */
export function latestRevision<T extends Revision>(revisions: readonly T[]): T {
  const [first, ...rest] = revisions
  if (first === undefined) {
    throw new RangeError('Cannot pick a latest revision from an empty list.')
  }
  return rest.reduce(
    (best, candidate) => (compareForWinner(candidate, best) > 0 ? candidate : best),
    first,
  )
}

/**
 * Unions the remarks of every revision by id, ordered by `(createdAt, id)`.
 *
 * Nothing is ever discarded — that is the whole point. Union alone would satisfy "nothing
 * lost" while producing a history in arbitrary order, which reads as corrupted even though no
 * data is missing, so the ordering is part of the contract.
 *
 * A remark id appearing in more than one revision with different text should not happen, since
 * remarks are immutable once written. It still needs a defined answer, and the answer is the
 * containing revision's `(updatedAt, _rev)` — the same rule as scalars. Leaving it undefined
 * would let two replicas keep different text for the same remark forever.
 */
export function mergeRemarks(revisions: readonly RemarkBearing[]): readonly Remark[] {
  const byId = new Map<string, { readonly remark: Remark; readonly from: Revision }>()

  for (const revision of revisions) {
    for (const remark of revision.remarks ?? []) {
      const existing = byId.get(remark.id)
      if (existing === undefined || compareForWinner(revision, existing.from) > 0) {
        byId.set(remark.id, { remark, from: revision })
      }
    }
  }

  return [...byId.values()]
    .map((entry) => entry.remark)
    .sort((a, b) => compareText(a.createdAt, b.createdAt) || compareText(a.id, b.id))
}

/**
 * Merges conflicting revisions of a device.
 *
 * Scalars come from the latest revision; remarks are unioned across all of them. The result
 * does not depend on which revision arrived as `winner`, so two replicas merging the same
 * conflict independently reach the same document.
 */
export function mergeDevice<T extends RemarkBearing>(winner: T, conflicts: readonly T[]): T {
  const revisions = [winner, ...conflicts]
  return { ...latestRevision(revisions), remarks: mergeRemarks(revisions) }
}

/** The most recent path any surviving revision remembers, or `undefined` if none does. */
function lastKnownPath(revisions: readonly RoomRevision[]): string | undefined {
  const named = revisions.filter(
    (revision) => revision._deleted !== true && revision.path !== undefined,
  )
  return named.length === 0 ? undefined : latestRevision(named).path
}

/** Prefixes a path with `Unassigned`, unless it is already there. */
function unassign(path: string): string {
  const segments = splitRoomPath(normaliseRoomPath(path))
  // Without this, a room deleted twice becomes `Unassigned/Unassigned/...` and the name grows
  // every time it happens.
  if (segments[0] === UNASSIGNED_ROOM_PREFIX) return segments.join(ROOM_PATH_SEPARATOR)
  return [UNASSIGNED_ROOM_PREFIX, ...segments].join(ROOM_PATH_SEPARATOR)
}

/**
 * Merges conflicting revisions of a room.
 *
 * Ordinarily last-write-wins on `path`. The exception is a room deleted on one replica while a
 * device still points at it: deleting it outright would orphan the device, so it comes back as
 * `Unassigned/<old path>`, keeping its id — which is what the device references, and therefore
 * what makes the device reachable again.
 *
 * A room whose path no surviving revision remembers stays deleted. Inventing a name would put
 * a room in the list nobody created; leaving it deleted keeps the loss visible at the device.
 *
 * @param options.hasLiveDevices Whether any device still references this room. Supplied by the
 *   caller because it cannot be known from these documents alone.
 */
export function mergeRoom<T extends RoomRevision>(
  winner: T,
  conflicts: readonly T[],
  options: { readonly hasLiveDevices: boolean },
): T {
  const revisions = [winner, ...conflicts]
  const latest = latestRevision(revisions)

  if (latest._deleted !== true || !options.hasLiveDevices) return latest

  const path = lastKnownPath(revisions)
  if (path === undefined) return latest

  const { _deleted, ...survivor } = latest
  return { ...survivor, path: unassign(path) } as unknown as T
}
