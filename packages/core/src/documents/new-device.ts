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
 * @module
 */

import { type DeviceCredential, readCredential } from '../matter/credential.js'
import { PayloadError } from '../matter/payload.js'
import {
  normaliseRoomPath,
  type RoomPathProblem,
  roomPathKey,
  roomPathProblem,
} from '../rooms/path.js'
import { documentId } from './ids.js'
import type { DeviceDocument, RoomDocument, Unsaved } from './types.js'

/** Which control the user has to go back to. A closed union, so a view cannot miss a case. */
export type DraftField = 'credential' | 'name' | 'room' | 'installedAt'

/**
 * A draft that cannot become a device, and the field responsible.
 *
 * The field is the point. An error that can only say "something is wrong" makes the user hunt
 * across six controls, and this is a form where one of them contains a code they cannot read.
 */
export class DraftError extends Error {
  override readonly name = 'DraftError'
  readonly field: DraftField

  constructor(field: DraftField, message: string, options?: ErrorOptions) {
    super(message, options)
    this.field = field
  }
}

/** The form's contents, as strings, exactly as controls report them. */
export interface DeviceDraft {
  /** An `MT:` payload or a manual pairing code; see `matter/credential.ts`. */
  readonly credential: string
  readonly name: string
  /** A room path, typed or chosen. Matched against existing rooms by {@link roomPathKey}. */
  readonly room: string
  readonly spot?: string
  readonly serial?: string
  /** A calendar date, `YYYY-MM-DD`, as an `<input type="date">` reports it. */
  readonly installedAt: string
}

/** What to write, in this order. */
export interface DeviceCreation {
  /** Write first. Absent when an existing room matched, which is the common case. */
  readonly room?: Unsaved<RoomDocument>
  readonly device: Unsaved<DeviceDocument>
}

/** The two impure things this decision needs, injected so `core` holds no ambient anything. */
export interface DraftClock {
  /** A fresh uuid per call; `crypto.randomUUID` at the impure boundary. */
  readonly uuid: () => string
  /** An ISO-8601 UTC timestamp, for `addedAt`. */
  readonly now: () => string
}

/** What each room-path problem means to someone looking at the field. */
const ROOM_PATH_MESSAGE: Readonly<Record<RoomPathProblem, string>> = {
  empty: 'A device needs a room. Type a name to create one, or pick an existing room.',
  emptySegment:
    'A room path is one or more non-empty names separated by "/", so "Ground Floor/Kitchen" works but a doubled or trailing "/" does not.',
}

/**
 * Whether a string is a calendar date that actually exists.
 *
 * The shape check alone is not enough: `2026-02-31` matches the pattern, and `new Date` rolls
 * it forward to 3 March rather than rejecting it, so a device would be filed under a date the
 * user never chose. Round-tripping through `toISOString` is what catches the roll.
 */
function isCalendarDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false
  const date = new Date(`${value}T00:00:00.000Z`)
  return !Number.isNaN(date.getTime()) && date.toISOString().startsWith(value)
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
    if (cause instanceof PayloadError) {
      throw new DraftError('credential', cause.message, { cause })
    }
    throw cause
  }

  const name = draft.name.trim()
  if (name === '') {
    throw new DraftError('name', 'A device needs a name; that is what makes it findable later.')
  }

  const problem = roomPathProblem(draft.room)
  if (problem !== null) {
    throw new DraftError('room', ROOM_PATH_MESSAGE[problem])
  }
  const path = normaliseRoomPath(draft.room)

  if (!isCalendarDate(draft.installedAt)) {
    throw new DraftError(
      'installedAt',
      'The installation date must be a real calendar date, written YYYY-MM-DD.',
    )
  }

  // By key, not by string: M1-5 already decided that `Ground Floor/Kitchen` and
  // `ground floor / kitchen` are the same room. Comparing paths directly here would be a
  // second answer to a question already answered, and the two would drift apart.
  const key = roomPathKey(path)
  const existing = rooms.find((room) => roomPathKey(room.path) === key)
  const roomId = existing?._id ?? documentId('room', clock.uuid())

  const spot = draft.spot?.trim() ?? ''
  const serial = draft.serial?.trim() ?? ''

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
    // Optional free text: kept when it says something, dropped when it is only whitespace.
    ...(spot === '' ? {} : { spot }),
    ...(serial === '' ? {} : { serial }),
    installedAt: draft.installedAt,
    addedAt: clock.now(),
    disabled: false,
    remarks: [],
  }

  return existing === undefined ? { room: { _id: roomId, type: 'room', path }, device } : { device }
}
