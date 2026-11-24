/**
 * Turning what someone typed into the documents that get written.
 *
 * The interesting part of "add a device" is not the markup: it is which spelling of the room it
 * is filed under, what the id is, and what defaults apply. All of that is a decision over plain
 * data, so it lives here and is tested in Node in milliseconds rather than through a rendered
 * form.
 *
 * This module **plans, and does not write**. Returning the document instead of saving it is
 * what makes "an invalid payload creates no device" true by construction: there is nothing
 * here that could write one.
 *
 * The rules it shares with editing an existing device live in `draft.ts`; see `edit-device.ts`
 * for the other caller.
 *
 * @module
 */

import { type CatalogFields, catalogFields } from '../catalog/copy.js'
import type { CatalogLookup } from '../catalog/types.js'
import { type DeviceCredential, readCredential } from '../matter/credential.js'
import { PayloadError } from '../matter/payload.js'
import {
  type DeviceFields,
  type DraftClock,
  DraftError,
  type DraftField,
  matchRoom,
  optionalText,
  readInstalledAt,
  readName,
  readRoomPath,
} from './draft.js'
import { documentId } from './ids.js'
import type { DeviceDocument, Unsaved } from './types.js'

/** The add form's contents: the shared controls, plus the one only a new device has. */
export interface DeviceDraft extends DeviceFields {
  /** An `MT:` payload or a manual pairing code; see `matter/credential.ts`. */
  readonly credential: string
}

/**
 * Reads the setup code, naming the field when it is not usable.
 *
 * Shared by `planNewDevice` and `checkDraftFields` so a step-by-step form and the final plan
 * cannot disagree about what a bad code is.
 *
 * @throws {DraftError} on `credential` when the code does not decode.
 */
export function credentialOf(draft: DeviceDraft): DeviceCredential {
  try {
    return readCredential(draft.credential)
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
      throw new DraftError('credential', cause.problem, cause.message, { cause })
    }
    throw cause
  }
}

/**
 * Plans the document for a new device.
 *
 * @param draft the form's contents
 * @param rooms every room path the project's devices already carry, so an existing spelling is
 *   reused (see `matchRoom`). Passed in rather than read, because reading is I/O and this
 *   package does none.
 * @param clock the uuid source and the wall clock
 * @param catalog the catalogue's answer for this code, when one arrived before Save. Passed in
 *   rather than fetched, so this stays pure. Ignored when its ids are not the code's: an answer
 *   that landed for a code since corrected would name this device after another one.
 * @returns the device to save
 * @throws {DraftError} for any unusable field, naming the field. Nothing is created; there is
 *   nothing here that could create anything.
 */
export function planNewDevice(
  draft: DeviceDraft,
  rooms: readonly string[],
  clock: DraftClock,
  catalog?: CatalogLookup,
): Unsaved<DeviceDocument> {
  const credential = credentialOf(draft)

  const name = readName(draft.name)
  const path = readRoomPath(draft.room)
  const installedAt = readInstalledAt(draft.installedAt)
  const room = matchRoom(path, rooms)
  // Read once: `addedAt` and `catalogCheckedAt` are the same moment, and two reads of a real
  // clock can straddle a second.
  const now = clock.now()
  const device: Unsaved<DeviceDocument> = {
    _id: documentId('device', clock.uuid()),
    type: 'device',
    name,
    room,
    ...credentialFields(credential),
    ...optionalText('spot', draft.spot),
    ...optionalText('serial', draft.serial),
    installedAt,
    addedAt: now,
    disabled: false,
    remarks: [],
    ...catalogFor(credential, catalog, now),
  }

  return device
}

/**
 * What a device stores of its setup code: the manual code always, the rest when the code
 * carried it. Shared with the draft planner (#358), so a draft's code is stored, and encrypted
 * (ADR 0022), exactly as a device's is.
 */
export function credentialFields(
  credential: DeviceCredential,
): Pick<
  DeviceDocument,
  | 'manualCode'
  | 'payload'
  | 'vendorId'
  | 'productId'
  | 'discriminator'
  | 'payloadVersion'
  | 'commissioningFlow'
  | 'discovery'
> {
  const { discovery } = credential
  return {
    manualCode: credential.manualCode,
    // Conditional spreads throughout: under `exactOptionalPropertyTypes` an explicit
    // `undefined` is not assignable to an optional field, which is the setting doing its job -
    // "absent" and "present and unknown" are different facts about a device's credential.
    ...(credential.payload === undefined ? {} : { payload: credential.payload }),
    ...(credential.vendorId === undefined ? {} : { vendorId: credential.vendorId }),
    ...(credential.productId === undefined ? {} : { productId: credential.productId }),
    ...(credential.discriminator === undefined ? {} : { discriminator: credential.discriminator }),
    ...(credential.version === undefined ? {} : { payloadVersion: credential.version }),
    ...(credential.customFlow === undefined ? {} : { commissioningFlow: credential.customFlow }),
    // The named flags only: `raw` stays in the payload, which remains the source of truth.
    ...(discovery === undefined
      ? {}
      : {
          discovery: {
            softAp: discovery.softAp,
            ble: discovery.ble,
            onNetwork: discovery.onNetwork,
          },
        }),
  }
}

/**
 * The catalogue block for `credential` from `catalog`, or nothing when the answer is about
 * another code: one that landed for a code since corrected would name this device after
 * another product.
 */
export function catalogFor(
  credential: DeviceCredential,
  catalog: CatalogLookup | undefined,
  now: string,
): Partial<CatalogFields> {
  return catalog !== undefined &&
    catalog.vendorId === credential.vendorId &&
    catalog.productId === credential.productId
    ? catalogFields(catalog, now)
    : {}
}

/**
 * Checks only the listed fields of a draft, throwing the first problem found.
 *
 * Why: the add form asks for its fields in steps and must refuse a step without waiting for
 * the last one. This runs the very readers `planNewDevice` uses, so the form never holds a
 * second opinion about what is valid. Fields are checked in the order `credential`,
 * `installedAt`, `room`, `name` whatever order they are passed in, so the same draft always
 * reports the same first problem. Fields with no check here (`remark`) are ignored.
 *
 * @param draft the form's contents
 * @param fields the fields to check
 * @throws {DraftError} for the first unusable listed field, naming it.
 */
export function checkDraftFields(draft: DeviceDraft, fields: readonly DraftField[]): void {
  if (fields.includes('credential')) credentialOf(draft)
  if (fields.includes('installedAt')) readInstalledAt(draft.installedAt)
  if (fields.includes('room')) readRoomPath(draft.room)
  if (fields.includes('name')) readName(draft.name)
}
