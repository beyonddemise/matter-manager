/**
 * Turning what someone typed into the documents that get written.
 *
 * The interesting part of "add a device" is not the markup: it is which room this belongs to,
 * whether that room is new, what the id is, and what defaults apply. All of that is a decision
 * over plain data, so it lives here and is tested in Node in milliseconds rather than through
 * a rendered form.
 *
 * This module **plans, and does not write**. Returning the documents instead of saving them is
 * what makes "an invalid payload creates no device" true by construction: there is nothing
 * here that could write one. It also means the caller controls the order, which matters —
 * a new room must reach the database before the device that points at it.
 *
 * The rules it shares with editing an existing device live in `draft.ts`; see `edit-device.ts`
 * for the other caller.
 *
 * @module
 */

import { type DeviceCredential, readCredential } from '../matter/credential.js'
import { PayloadError } from '../matter/payload.js'
import {
  chooseRoom,
  type DeviceFields,
  type DraftClock,
  DraftError,
  optionalText,
  readInstalledAt,
  readName,
  readRoomPath,
} from './draft.js'
import { documentId } from './ids.js'
import type { DeviceDocument, RoomDocument, Unsaved } from './types.js'

/** The add form's contents: the shared controls, plus the one only a new device has. */
export interface DeviceDraft extends DeviceFields {
  /** An `MT:` payload or a manual pairing code; see `matter/credential.ts`. */
  readonly credential: string
}

/** What to write, in this order. */
export interface DeviceCreation {
  /** Write first. Absent when an existing room matched, which is the common case. */
  readonly room?: Unsaved<RoomDocument>
  readonly device: Unsaved<DeviceDocument>
}

/**
 * Plans the documents for a new device.
 *
 * @param draft the form's contents
 * @param rooms every room already in the project, so an existing one can be reused rather than
 *   duplicated. Passed in rather than read, because reading is I/O and this package does none.
 * @param clock the uuid source and the wall clock
 * @returns the device, and the room to write before it when the room is new
 * @throws {DraftError} for any unusable field, naming the field. Nothing is created; there is
 *   nothing here that could create anything.
 */
export function planNewDevice(
  draft: DeviceDraft,
  rooms: readonly RoomDocument[],
  clock: DraftClock,
): DeviceCreation {
  let credential: DeviceCredential
  try {
    credential = readCredential(draft.credential)
  } catch (cause) {
    // Only a `PayloadError` is a statement about the input. Anything else is a bug in the
    // codec, and relabelling it as "your code is wrong" would send the user to inspect a
    // label that was fine - the same rule `decodePayload` applies to non-Base38 failures.
    //
    // Unreachable from outside by construction, and deliberately left uncovered rather than
    // removed: no input a caller can supply makes `readCredential` throw anything else, so a
    // mutation probe reports the rethrow as a survivor and a coverage report as a hole. Both
    // are correct, and both are the wrong reason to delete a guard against mislabelling a bug
    // as a user's mistake. `payload.ts` keeps the same branch for the same reason.
    if (cause instanceof PayloadError && cause.problem !== undefined) {
      throw new DraftError('credential', cause.problem, cause.message, { cause })
    }
    throw cause
  }

  const name = readName(draft.name)
  const path = readRoomPath(draft.room)
  const installedAt = readInstalledAt(draft.installedAt)
  const { roomId, room } = chooseRoom(path, rooms, clock.uuid)

  const device: Unsaved<DeviceDocument> = {
    _id: documentId('device', clock.uuid()),
    type: 'device',
    name,
    roomId,
    manualCode: credential.manualCode,
    // Conditional spreads throughout: under `exactOptionalPropertyTypes` an explicit
    // `undefined` is not assignable to an optional field, which is the setting doing its job -
    // "absent" and "present and unknown" are different facts about a device's credential.
    ...(credential.payload === undefined ? {} : { payload: credential.payload }),
    ...(credential.vendorId === undefined ? {} : { vendorId: credential.vendorId }),
    ...(credential.productId === undefined ? {} : { productId: credential.productId }),
    ...(credential.discriminator === undefined ? {} : { discriminator: credential.discriminator }),
    ...optionalText('spot', draft.spot),
    ...optionalText('serial', draft.serial),
    installedAt,
    addedAt: clock.now(),
    disabled: false,
    remarks: [],
  }

  return room === undefined ? { device } : { room, device }
}
