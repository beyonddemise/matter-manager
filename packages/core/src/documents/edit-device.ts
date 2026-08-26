/**
 * Changing a device that already exists: its description, its room, and whether it is in
 * service.
 *
 * Everything here **plans and does not write**, for the same reason `new-device.ts` does: a
 * planner that returns documents cannot half-apply a change, and the caller keeps control of
 * the write order — a new room has to reach the database before the device that points at it.
 *
 * What it deliberately cannot change is the setup code. `payload`, `vendorId`, `productId` and
 * `discriminator` are all derived from the credential, so editing one without re-deriving the
 * rest would produce a record whose parts disagree — and a QR built from a payload that no
 * longer matches its device encodes cleanly, renders cleanly, and silently fails to
 * commission. A code captured from the wrong label is fixed by deleting the record and adding
 * it again, which is what the delete confirmation exists for.
 *
 * @module
 */

import {
  chooseRoom,
  type DeviceFields,
  optionalText,
  readInstalledAt,
  readName,
  readRoomPath,
} from './draft.js'
import type { DeviceDocument, RoomDocument, Unsaved } from './types.js'

/** What to write, in this order. Same shape as `DeviceCreation`, for the same reason. */
export interface DeviceUpdate {
  /** Write first. Absent unless the edit moved the device into a room that does not exist yet. */
  readonly room?: Unsaved<RoomDocument>
  readonly device: Unsaved<DeviceDocument>
}

/**
 * The document minus the stamp the repository owns.
 *
 * `updatedAt` is half of the total order the conflict merge depends on (ADR 0010). `Unsaved`
 * omits it precisely so a caller cannot supply one, and a document written with a stale stamp
 * does not fail — it quietly loses every future conflict against a correctly stamped one.
 * `_rev` is kept, because an update without it is a create that will be rejected.
 */
function withoutStamp(device: DeviceDocument): Unsaved<DeviceDocument> {
  const { updatedAt: _stamp, ...rest } = device
  return rest
}

/**
 * Plans the documents for an edited device.
 *
 * Everything not named in {@link DeviceFields} is carried through untouched, and that is the
 * load-bearing half: the credential, `addedAt`, `remarks`, and `disabled`/`disabledAt`.
 * Renaming a disabled device must not quietly put it back into service.
 *
 * Only `uuid` is injected rather than a whole `DraftClock`. An edit has no `addedAt` to stamp,
 * so asking for a wall clock it never reads would misstate what this depends on.
 *
 * @param device the device as read, `_rev` included
 * @param fields the form's contents
 * @param rooms every room already in the project, so a move into an existing room reuses it
 * @param uuid the uuid source, used only when the edit names a room that does not exist yet
 * @returns the device, and the room to write before it when that room is new
 * @throws {DraftError} for any unusable field, naming the field. Nothing is written; there is
 *   nothing here that could write anything.
 */
export function planDeviceEdit(
  device: DeviceDocument,
  fields: DeviceFields,
  rooms: readonly RoomDocument[],
  uuid: () => string,
): DeviceUpdate {
  const name = readName(fields.name)
  const path = readRoomPath(fields.room)
  const installedAt = readInstalledAt(fields.installedAt)
  const { roomId, room } = chooseRoom(path, rooms, uuid)

  // `spot` and `serial` are rebuilt rather than overwritten: clearing one has to *remove* the
  // field, and spreading `{ spot: '' }` over the old document would store an empty spot that
  // reads back as a spot which exists and says nothing.
  const { spot: _oldSpot, serial: _oldSerial, ...carried } = withoutStamp(device)

  const updated: Unsaved<DeviceDocument> = {
    ...carried,
    name,
    roomId,
    ...optionalText('spot', fields.spot),
    ...optionalText('serial', fields.serial),
    installedAt,
  }

  return room === undefined ? { device: updated } : { room, device: updated }
}

/**
 * Takes a device out of service, or puts it back.
 *
 * Disabling keeps everything, including the payload, so the QR stays reproducible — that is
 * the entire reason this is not a delete. A device that comes off a wall may go back up
 * somewhere else, and its setup code is the one thing that cannot be recreated.
 *
 * Re-enabling **removes** `disabledAt` rather than leaving it behind. A timestamp saying "this
 * was disabled at 14:02" on a device that is currently in service is not history, it is a
 * false statement about the present; history belongs in remarks (M2-9) and the audit log (M7).
 *
 * Disabling something already disabled keeps the original timestamp. The fact worth recording
 * is when the device went out of service, not when someone last pressed the button — and two
 * replicas both disabling it should not disagree about which one counts.
 *
 * @param device the device as read, `_rev` included
 * @param disabled the state to move to
 * @param now an ISO-8601 UTC timestamp source, read only when a device is newly disabled
 */
export function setDeviceDisabled(
  device: DeviceDocument,
  disabled: boolean,
  now: () => string,
): Unsaved<DeviceDocument> {
  const { disabledAt, ...rest } = withoutStamp(device)

  if (!disabled) return { ...rest, disabled: false }

  // Keyed on `device.disabled` rather than on the stamp alone: a `disabledAt` on a device that
  // is currently in service is a document this function would never have written, and reusing
  // it would date the new outage to an old one.
  const at = device.disabled && disabledAt !== undefined ? disabledAt : now()
  return { ...rest, disabled: true, disabledAt: at }
}
