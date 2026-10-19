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

import { withCatalogBlock } from '../catalog/copy.js'

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

/** A revision that may carry a catalogue block (`catalog/copy.ts`). */
export interface CatalogBearing {
  readonly catalogCheckedAt?: string
}

/**
 * The revision whose catalogue block wins: the newest `catalogCheckedAt`, ties broken by the
 * same `(updatedAt, _rev)` order as scalars so that every replica picks the same one.
 */
function catalogueSource<T extends Revision & CatalogBearing>(
  revisions: readonly T[],
): T | undefined {
  let best: T | undefined
  for (const revision of revisions) {
    if (revision.catalogCheckedAt === undefined) continue
    if (
      best === undefined ||
      compareText(revision.catalogCheckedAt, best.catalogCheckedAt ?? '') > 0 ||
      (revision.catalogCheckedAt === best.catalogCheckedAt && compareForWinner(revision, best) > 0)
    ) {
      best = revision
    }
  }
  return best
}

/**
 * Merges conflicting revisions of a device.
 *
 * Scalars come from the latest revision; remarks are unioned across all of them; the
 * catalogue block comes, whole, from the revision that consulted the catalogue last. The block
 * has its own clock (`catalogCheckedAt`) because it is written by backfill, not by the person
 * editing: a newer rename that never saw the lookup must not erase what the lookup found.
 *
 * The result does not depend on which revision arrived as `winner`, so two replicas merging the
 * same conflict independently reach the same document.
 */
export function mergeDevice<T extends RemarkBearing & CatalogBearing>(
  winner: T,
  conflicts: readonly T[],
): T {
  const revisions = [winner, ...conflicts]
  const latest = latestRevision(revisions)
  const merged = { ...latest, remarks: mergeRemarks(revisions) }
  const source = catalogueSource(revisions)
  return source === undefined || source === latest ? merged : withCatalogBlock(merged, source)
}
