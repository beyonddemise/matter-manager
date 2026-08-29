/**
 * Finding conflicts, applying the merge, and removing what lost (ADR 0010).
 *
 * The decision of *how* two conflicting revisions combine lives in `core` — pure functions over
 * plain data, so that every replica computes the same answer independently. This module is the
 * other half: the impure part that reads the losing revisions out of the database, hands them
 * to that decision, writes the result and deletes the branches that lost.
 *
 * The split is the point. CouchDB detects conflicts and picks a winner, but it does not merge:
 * the losing revision stays in the tree where nothing surfaces it, so a remark somebody wrote
 * offline **disappears from the interface without any error anywhere**. Nobody notices, so
 * nobody reports it. Everything here exists to close that gap.
 *
 * @module
 */

import type { Revision } from '@matter-manager/core'

/**
 * A document as read with `conflicts: true`.
 *
 * `_conflicts` is an annotation the database adds at read time, not a field of the document.
 * Writing one back is a `doc_validation` failure — so it is stripped before anything is
 * returned or stored, and that is the reason {@link ConflictResolver.resolve} is on the path of
 * every read rather than only of conflicted ones.
 */
export type Conflicted<T> = T & { readonly _conflicts?: readonly string[] }

/**
 * How one document type's conflicting revisions combine into the one to keep.
 *
 * `core`'s `mergeDevice` and `mergeRoom` have this shape. Asynchronous because a room's merge
 * needs to know whether any device still points at it, which is a query.
 */
export type MergeStrategy<T extends Revision> = (winner: T, losers: readonly T[]) => T | Promise<T>

/** Resolves conflicts against one database. */
export interface ConflictResolver {
  /**
   * The document to show, with its conflicts merged away.
   *
   * A document with no conflicts is returned unchanged apart from the stripped annotation, and
   * nothing is written — so this is safe to call on every read.
   */
  resolve<T extends Revision>(document: Conflicted<T>, merge: MergeStrategy<T>): Promise<T>
}

/**
 * How many times a resolution will re-read and try again after losing a race.
 *
 * A 409 here means somebody wrote the document between the read and the merge — the user
 * editing it, or another resolver. Retrying is right, but retrying forever would turn a
 * persistent disagreement into a spin, so it is bounded and the last failure is raised.
 */
const RESOLUTION_ATTEMPTS = 3

/** PouchDB reports a lost race with `status: 409`. */
function isConflict(error: unknown): boolean {
  return (
    typeof error === 'object' && error !== null && (error as { status?: unknown }).status === 409
  )
}

/** PouchDB reports a missing document with `status: 404`. */
function isMissing(error: unknown): boolean {
  return (
    typeof error === 'object' && error !== null && (error as { status?: unknown }).status === 404
  )
}

/** The document without the read-time annotation. */
function withoutConflicts<T>(document: Conflicted<T>): T {
  const { _conflicts, ...rest } = document as Conflicted<T> & { _conflicts?: unknown }
  return rest as T
}

/**
 * A canonical string for a document's content, ignoring `_rev`.
 *
 * Used only to answer "would writing this change anything". Keys are sorted because two
 * documents that differ in key order are the same document, and a comparison that said
 * otherwise would write a new revision on every read of a resolved conflict.
 */
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`
  if (value !== null && typeof value === 'object') {
    return `{${Object.entries(value as Record<string, unknown>)
      .filter(([key]) => key !== '_rev' && key !== '_conflicts')
      .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
      .map(([key, entry]) => `${JSON.stringify(key)}:${canonical(entry)}`)
      .join(',')}}`
  }
  return JSON.stringify(value) ?? 'undefined'
}

/** Whether two documents say the same thing, whatever revision each one is. */
function sameContent(left: unknown, right: unknown): boolean {
  return canonical(left) === canonical(right)
}

/** A row `bulkDocs` reports as a failure. */
function bulkFailure(result: unknown): { readonly name?: string } | undefined {
  return typeof result === 'object' && result !== null && 'error' in result
    ? (result as { readonly name?: string })
    : undefined
}

/**
 * Builds a resolver for one open database.
 *
 * One per database rather than one per repository, because the resolutions of a document must
 * not race each other: a read and the change feed can both reach the same conflict at the same
 * moment, and two resolvers would each merge, each write, and one would lose to the other for
 * no reason. The in-flight resolution is shared instead.
 */
export function conflictResolver(database: PouchDB.Database): ConflictResolver {
  /**
   * Resolutions currently running, by document id.
   *
   * Forgotten on failure as well as success, so a transient error is retried by the next
   * caller rather than remembered as the answer.
   */
  const inFlight = new Map<string, Promise<unknown>>()

  /** Reads every losing revision. They are addressed by revision, so no conflict is lost. */
  const losingRevisions = async <T>(id: string, revisions: readonly string[]): Promise<T[]> =>
    Promise.all(revisions.map(async (rev) => (await database.get(id, { rev })) as unknown as T))

  /**
   * Deletes the branches that lost.
   *
   * A `conflict` here means somebody else already deleted this revision, which is the outcome
   * being asked for; anything else is a real failure and is raised, because a prune that
   * silently did nothing leaves `_conflicts` growing forever and every read paying for it.
   */
  const prune = async (id: string, revisions: readonly string[]): Promise<void> => {
    const results = await database.bulkDocs(
      revisions.map((rev) => ({ _id: id, _rev: rev, _deleted: true })),
    )
    const failures = results
      .map(bulkFailure)
      .filter((failure) => failure !== undefined && failure.name !== 'conflict')

    if (failures.length > 0) {
      throw new AggregateError(
        failures,
        `Losing revisions of ${JSON.stringify(id)} could not be removed.`,
      )
    }
  }

  /** One attempt: read the losers, merge, write, prune. */
  const attempt = async <T extends Revision>(
    document: Conflicted<T>,
    merge: MergeStrategy<T>,
  ): Promise<T> => {
    const revisions = document._conflicts ?? []
    const winner = withoutConflicts(document)
    if (revisions.length === 0) return winner

    const losers = await losingRevisions<T>(document._id, revisions)
    const merged = withoutConflicts(await merge(winner, losers))

    let current = winner
    if (!sameContent(merged, winner)) {
      // Written onto the **winning** branch, whichever revision the merge happened to take its
      // scalars from. The losing branches are about to be deleted, and a merge written onto one
      // of them would be deleted along with it.
      const { rev } = await database.put({ ...merged, _rev: winner._rev })
      current = { ...merged, _rev: rev }
    }

    // Second, never first. Between these two writes the merged document already exists, so an
    // interruption leaves a resolved document with a stale conflict on it — which the next read
    // fixes. The other order has a window where the only copy of somebody's remark is a
    // revision that has just been deleted.
    await prune(document._id, revisions)
    return current
  }

  /** Re-reads after losing a race, so the retry merges what is actually there now. */
  const reread = async <T extends Revision>(
    document: Conflicted<T>,
  ): Promise<Conflicted<T> | undefined> => {
    try {
      return (await database.get(document._id, { conflicts: true })) as unknown as Conflicted<T>
    } catch (error) {
      // Deleted while we were merging. There is no document to resolve any more, and inventing
      // one by writing the merge back would resurrect something somebody removed.
      if (isMissing(error)) return undefined
      throw error
    }
  }

  const run = async <T extends Revision>(
    document: Conflicted<T>,
    merge: MergeStrategy<T>,
  ): Promise<T> => {
    let subject = document
    for (let remaining = RESOLUTION_ATTEMPTS; remaining > 0; remaining -= 1) {
      try {
        return await attempt(subject, merge)
      } catch (error) {
        if (!isConflict(error) || remaining === 1) throw error
        const fresh = await reread(subject)
        if (fresh === undefined) return withoutConflicts(subject)
        subject = fresh
      }
    }
    // Unreachable: the loop either returns or throws on its final pass. Present because the
    // compiler cannot see that, and a thrown error says more than an invented document would.
    throw new Error(`Resolving ${JSON.stringify(document._id)} did not terminate.`)
  }

  return {
    async resolve<T extends Revision>(
      document: Conflicted<T>,
      merge: MergeStrategy<T>,
    ): Promise<T> {
      // The cheap path, and the common one: no conflict, no write, no bookkeeping.
      if ((document._conflicts ?? []).length === 0) return withoutConflicts(document)

      const running = inFlight.get(document._id)
      if (running !== undefined) return running as Promise<T>

      const resolution = run(document, merge).finally(() => {
        inFlight.delete(document._id)
      })
      inFlight.set(document._id, resolution)
      return resolution
    },
  }
}

/** A running watch. */
export interface ConflictWatch {
  /** Stops it. Safe to call more than once. */
  cancel(): void
}

/** What a watch reports. */
export interface WatchOptions {
  /** Called for each changed document that has conflicts. */
  readonly onConflicted: (document: Conflicted<Revision>) => Promise<unknown>
  /** Called when a resolution fails, or the feed does. Unhandled otherwise. */
  readonly onError?: (error: unknown) => void
}

/**
 * Resolves conflicts as replication delivers them.
 *
 * ADR 0010: conflict resolution must run on **every** change event, not only on user-visible
 * edits. A conflict is created by replication, asynchronously, long after the write that caused
 * it — often on a device whose user is doing nothing at all. Resolving only on read would leave
 * the merge undone until somebody happened to open that device, and leave `_conflicts`
 * accumulating in the meantime.
 *
 * It does **not** reach a deletion that lost. A deleted leaf loses to a live one whatever its
 * generation, and a deleted losing branch is reported in neither `_conflicts` nor the change
 * feed — CouchDB puts those in `_deleted_conflicts`, which PouchDB does not implement, and only
 * `get(id, { open_revs: 'all' })` can see one at the cost of a second read per document. So
 * "deleted here, edited there" always resolves as *the edit survives*, which loses the deletion
 * and orphans nothing. `mergeRoom`'s resurrection branch is unreachable from here as a result;
 * see `docs/tasks/todo-53.md`.
 *
 * `since: 'now'` rather than from the beginning — the existing backlog is what a read resolves,
 * and re-scanning the whole database on every start would cost most on the devices that can
 * afford it least.
 */
export function watchConflicts(database: PouchDB.Database, options: WatchOptions): ConflictWatch {
  const feed = database.changes({
    live: true,
    since: 'now',
    include_docs: true,
    conflicts: true,
  })

  feed.on('change', (change) => {
    const document = change.doc as Conflicted<Revision> | undefined
    if (document === undefined || (document._conflicts ?? []).length === 0) return
    void Promise.resolve(options.onConflicted(document)).catch((error: unknown) => {
      options.onError?.(error)
    })
  })

  feed.on('error', (error: unknown) => {
    options.onError?.(error)
  })

  return {
    // Straight through to PouchDB, which tolerates being cancelled twice — asserted in
    // `conflict-resolver.test.ts`, since a page teardown and a sign-out can both do it. A guard
    // here would be a branch no test could distinguish from its absence.
    cancel: () => {
      feed.cancel()
    },
  }
}
