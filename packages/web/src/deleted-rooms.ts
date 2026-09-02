/**
 * What this device deleted, remembered so a deletion that did not stick can be explained.
 *
 * Local to the browser and never replicated, deliberately. The record exists to answer "did *I*
 * delete this?", and a record that travelled would answer it for everybody — including the
 * person whose rename won, who has nothing to be told (#125, second scenario).
 *
 * Kept in `localStorage` rather than a database: it is a handful of ids, it must survive a
 * reload, and it must not be replicated. A PouchDB database would satisfy the first two and
 * quietly risk the third.
 *
 * @module
 */

import type { DeletedRoom, RoomDocument } from '@matter-manager/core'
import { worthRemembering } from '@matter-manager/core'

/**
 * Per database, because room ids are per project.
 *
 * Sharing one list across projects would compare this project's rooms against another's
 * deletions — ids that can never match, so it would report nothing rather than something wrong.
 * Keyed anyway, because "wrong in a harmless direction" is not a property worth relying on.
 */
const key = (dbName: string): string => `matter-manager.deleted-rooms.${dbName}`

/** What this device deleted from one project, oldest first. Empty when storage refuses. */
export function readDeletedRooms(
  getStorage: () => Pick<Storage, 'getItem'>,
  dbName: string,
): readonly DeletedRoom[] {
  try {
    const stored = getStorage().getItem(key(dbName))
    if (stored === null) return []

    const parsed: unknown = JSON.parse(stored)
    if (!Array.isArray(parsed)) return []

    // Checked rather than trusted: this is a value from storage, which an older build wrote and
    // anybody can edit. A malformed entry would otherwise reach `resurrectedRooms` and match an
    // id of `undefined` against a room that has none.
    return parsed.filter(
      (entry): entry is DeletedRoom =>
        typeof entry === 'object' &&
        entry !== null &&
        typeof (entry as DeletedRoom).roomId === 'string' &&
        typeof (entry as DeletedRoom).path === 'string' &&
        typeof (entry as DeletedRoom).deletedAt === 'string',
    )
  } catch {
    // Private browsing, an origin refusing storage, or JSON that will not parse. Not knowing
    // what was deleted costs an explanation, never data.
    return []
  }
}

/** Replaces the list. A refused write costs the explanation, not the deletion. */
export function writeDeletedRooms(
  getStorage: () => Pick<Storage, 'setItem'>,
  dbName: string,
  deleted: readonly DeletedRoom[],
): void {
  try {
    getStorage().setItem(key(dbName), JSON.stringify(deleted))
  } catch {
    // The deletion still happened. This is only how it would have been explained.
  }
}

/** Records a deletion, dropping records that are no longer worth keeping. */
export function rememberDeletion(
  getStorage: () => Pick<Storage, 'getItem' | 'setItem'>,
  dbName: string,
  room: RoomDocument,
  rooms: readonly RoomDocument[],
  now: () => number = () => Date.now(),
): void {
  const kept = worthRemembering(readDeletedRooms(getStorage, dbName), rooms, now)
  writeDeletedRooms(getStorage, dbName, [
    ...kept.filter((record) => record.roomId !== room._id),
    { roomId: room._id, path: room.path, deletedAt: new Date(now()).toISOString() },
  ])
}

/**
 * Forgets one deletion, because the reader has now been told about it.
 *
 * Called when the message is dismissed *or* when the room is deleted again — the second is the
 * one that matters, because deleting it again writes a fresh record, and leaving the old one
 * would report the same resurrection twice.
 */
export function forgetDeletion(
  getStorage: () => Pick<Storage, 'getItem' | 'setItem'>,
  dbName: string,
  roomId: string,
): void {
  writeDeletedRooms(
    getStorage,
    dbName,
    readDeletedRooms(getStorage, dbName).filter((record) => record.roomId !== roomId),
  )
}
