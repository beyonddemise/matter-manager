/**
 * Appending a remark to a device, and the order remarks are read in.
 *
 * Remarks are an **append-only log**. Nothing here edits or removes one, and that is a design
 * decision rather than an unimplemented feature: mutability would defeat both the audit value
 * and the conflict-free merge. `mergeRemarks` (ADR 0010) unions by id across conflicting
 * revisions and discards nothing, which is only sound while a given id means one fixed piece
 * of text — a remark rewritten offline on one replica would otherwise resolve arbitrarily
 * against its own earlier self.
 *
 * Like the rest of `documents/`, this **plans and does not write**. It returns the device to
 * save; the caller performs the write.
 *
 * @module
 */

import type { Remark } from '../sync/merge.js'
import { type DraftClock, DraftError } from './draft.js'
import type { DeviceDocument, Unsaved } from './types.js'

/**
 * Who wrote a remark.
 *
 * Both fields are stored, and the duplication is deliberate. `sub` is the stable identity and
 * the only thing worth authorising against; `name` is what a reader needs years later, when
 * the person may have left the project and no lookup can resolve their subject claim to
 * anything. A remark that can only say `auth0|abc123` is an audit record nobody can read.
 */
export interface RemarkAuthor {
  /** The identity provider's stable subject claim. */
  readonly sub: string
  /** The display name **as it was when the remark was written**; never resolved again later. */
  readonly name: string
}

/**
 * Plans a device with one more remark on it.
 *
 * Existing remarks are carried through **by reference**, not rebuilt. The difference is
 * invisible in a value comparison and is the whole point: a rebuild is a rewrite, and this is
 * the one document shape where a rewrite is the failure being guarded against.
 *
 * The new remark goes at the end, matching the order `mergeRemarks` produces — oldest first.
 * Display order is {@link remarksNewestFirst} and is deliberately a separate function; storing
 * remarks in display order would put the stored array in an order the merge does not produce,
 * so a merged document and an unmerged one would differ for no reason a reader could see.
 *
 * @param device the device as read, `_rev` included
 * @param text what the user typed; trimmed, and blank is refused
 * @param author who is writing it, resolved by the caller — `core` knows nothing about sessions
 * @param clock the uuid source for the remark id and the timestamp for `createdAt`
 * @returns the device to save, without the `updatedAt` the repository owns
 * @throws {DraftError} on `remark` when the text says nothing
 */
export function addRemark(
  device: DeviceDocument,
  text: string,
  author: RemarkAuthor,
  clock: DraftClock,
): Unsaved<DeviceDocument> {
  const said = text.trim()
  if (said === '') {
    throw new DraftError('remark', 'A remark needs some text; there is nothing to record yet.')
  }

  const remark: Remark = {
    id: clock.uuid(),
    text: said,
    authorSub: author.sub,
    authorName: author.name,
    createdAt: clock.now(),
  }

  // `updatedAt` is dropped rather than passed on: it is half of the total order the conflict
  // merge depends on (ADR 0010), the repository owns the stamp, and a document written with a
  // stale one does not fail — it quietly loses every future conflict against a fresh one.
  const { updatedAt: _stamp, ...rest } = device
  return { ...rest, remarks: [...device.remarks, remark] }
}

/** Compares two strings, returning the usual negative, zero or positive. */
const compareText = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0)

/**
 * Remarks in the order they are read: newest first.
 *
 * The most recent remark is the one that says what state the device is in now, so it belongs
 * where the eye lands. Equal timestamps break by id **descending**, the exact reverse of the
 * stored order, so that the display is a reversal of storage rather than an order of its own —
 * two remarks written in the same millisecond on two replicas then read the same way
 * everywhere, instead of swapping places depending on which replica rendered them.
 *
 * Copies rather than reversing in place: the array belongs to the document.
 */
export function remarksNewestFirst(remarks: readonly Remark[]): readonly Remark[] {
  return [...remarks].sort(
    (a, b) => compareText(b.createdAt, a.createdAt) || compareText(b.id, a.id),
  )
}
