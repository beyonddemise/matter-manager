/**
 * Noticing that a room you deleted has come back.
 *
 * Two people, both offline. One deletes a room; the other renames it. When they reconnect the
 * rename wins — always — and the person who deleted the room finds it back in their list under
 * a name they have never seen, with nothing to say why. Their reasonable conclusion is that the
 * deletion did not save (#125).
 *
 * **The outcome is correct and is not what is being changed here.** A live leaf beats a deleted
 * one whatever its generation, no device is orphaned, and making the deletion win would need
 * `open_revs: 'all'` on every document on every read. What was missing is the explanation.
 *
 * ## Why this is a comparison and not a merge
 *
 * `mergeRoom`'s resurrection branch cannot be reached: CouchDB reports a losing deletion in
 * neither `_conflicts` nor the change feed — those go in `_deleted_conflicts`, which PouchDB
 * does not implement — and when every branch is deleted the feed carries a bare tombstone with
 * no conflicts on it. So the merge never runs for this case, and anything built on it would be
 * built on nothing (L32).
 *
 * The signal that *does* exist belongs to the deleting device alone: it knows what it deleted,
 * and it can see what is in the list. A spike against three replicating databases confirmed the
 * room arrives back on that device as a **live** document under the other person's name, through
 * its own change feed, with no extra read:
 *
 * ```
 * heardAboutIt: true   arrivedDeleted: false   isAliveOnA: true   pathOnA: "Cocina"
 * ```
 *
 * @module
 */

import type { RoomDocument } from '../documents/types.js'

/** A room this device deleted, remembered so its return can be recognised. */
export interface DeletedRoom {
  readonly roomId: string
  /** What it was called when it was deleted, so the message can say what was meant. */
  readonly path: string
  /** ISO-8601, for pruning a record nobody will ever be shown. */
  readonly deletedAt: string
}

/** A deletion that did not stick, and the room as it now stands. */
export interface ResurrectedRoom {
  readonly deleted: DeletedRoom
  /** The room that is back, under whatever name the other person gave it. */
  readonly room: RoomDocument
}

/**
 * Which of the rooms this device deleted are present again.
 *
 * A comparison rather than a subscription, and that is deliberate: the rooms list is read
 * anyway, so the answer costs nothing extra — and it is the same answer whether the room came
 * back a second ago or while the tab was closed. A change-feed listener would only notice the
 * first.
 *
 * Matched by **id**, not by path. The whole point is that the room came back under a different
 * name, so a path comparison would find nothing precisely when there is something to find.
 */
export function resurrectedRooms(
  deleted: readonly DeletedRoom[],
  rooms: readonly RoomDocument[],
): readonly ResurrectedRoom[] {
  const present = new Map(rooms.map((room) => [room._id, room]))

  return deleted.flatMap((record) => {
    const room = present.get(record.roomId)
    return room === undefined ? [] : [{ deleted: record, room }]
  })
}

/**
 * How long a record of a deletion is worth keeping.
 *
 * A room that has not come back within a month is not going to: the other device would have had
 * to be offline for that long with an edit in hand. Keeping the record forever would mean a list
 * that only grows, and a resurrection reported for a room somebody deleted last year is not news
 * — it is a puzzle.
 */
export const DELETION_MEMORY_DAYS = 30

/**
 * The records still worth keeping: recent ones, and any whose room is back.
 *
 * A room that has already returned is kept regardless of age, because the reader has not been
 * told yet — expiring the record would remove the explanation rather than the problem.
 */
export function worthRemembering(
  deleted: readonly DeletedRoom[],
  rooms: readonly RoomDocument[],
  now: () => number,
): readonly DeletedRoom[] {
  const present = new Set(rooms.map((room) => room._id))
  const cutoff = now() - DELETION_MEMORY_DAYS * 24 * 60 * 60 * 1000

  return deleted.filter(
    (record) => present.has(record.roomId) || Date.parse(record.deletedAt) > cutoff,
  )
}
