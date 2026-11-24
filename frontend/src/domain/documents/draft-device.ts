/**
 * Saving a device before it is complete, and finishing it later (#358).
 *
 * In the field a label is often readable while the room is not decided yet, or the person is
 * interrupted. A draft keeps what they have: a {@link DraftDeviceDocument}, which is a device
 * with a draft status under the same `device:` id, not a document type of its own (the product
 * owner's decision of 2026-11-24 on #358).
 *
 * Two planners, two rules:
 *
 * - {@link planDraftDevice} is lenient about what is **missing** and strict about what is
 *   **there**. A draft needs one value; every value it has must pass the reader a device's
 *   value passes. A setup code that does not decode is refused even in a draft: a stored code
 *   is a secret at rest (ADR 0022) and a QR on a printed label, and a half-typed one would be
 *   both, wrong. The same holds for a malformed room path, which would put a broken room on the
 *   Rooms page (ADR 0021: a draft's room is a room like any device's).
 * - {@link planFinishedDevice} is `planNewDevice` itself, with the draft's identity kept. There
 *   is no other way from a draft to a {@link DeviceDocument}, which is the type-level half of
 *   "finishing runs the full checks".
 *
 * Like the rest of this package, these plan and do not write.
 *
 * @module
 */

import { CATALOG_FIELD_KEYS, type CatalogFields } from '../catalog/copy.js'
import type { CatalogLookup } from '../catalog/types.js'
import {
  type DraftClock,
  DraftError,
  matchRoom,
  optionalText,
  readInstalledAt,
  readRoomPath,
} from './draft.js'
import { documentId, uuidOf } from './ids.js'
import {
  catalogFor,
  credentialFields,
  credentialOf,
  type DeviceDraft,
  planNewDevice,
} from './new-device.js'
import type { DeviceDocument, DraftDeviceDocument, StoredDevice, Unsaved } from './types.js'

/** Whether a stored device is a draft. The one test every consumer narrows with. */
export function isDraftDevice(device: StoredDevice): device is DraftDeviceDocument {
  return device.status === 'draft'
}

/** `{ [key]: value }` for a value, `{}` for none: absent, never empty, in a stored document. */
const present = <K extends string, V>(key: K, value: V | undefined): { [P in K]?: V } =>
  (value === undefined ? {} : { [key]: value }) as { [P in K]?: V }

/** The trimmed text, or `undefined` when there is none. */
const typed = (value: string | undefined): string | undefined => {
  const text = value?.trim() ?? ''
  return text === '' ? undefined : text
}

/**
 * Plans a draft: what the form holds, each present value checked, the rest left absent.
 *
 * At least one of the setup code, name, room, spot and serial number must say something. The
 * installation date does not count on its own: the form fills it with today, so a "draft" of
 * only a date would be a form nobody touched.
 *
 * @param draft the form's contents
 * @param rooms every room path the project's devices carry, so a typed room joins an existing
 *   spelling exactly as a device's would (`matchRoom`)
 * @param clock the uuid source, asked only for a new draft, and the wall clock
 * @param catalog the catalogue's answer for this code, when one has arrived; ignored when it is
 *   about another code
 * @param stored the draft being saved again, if it is one: its id, revision, added date and
 *   remarks are kept, so saving twice updates one document rather than creating a second
 * @returns the draft to save
 * @throws {DraftError} `draftEmpty` on `credential` when there is nothing at all, or the first
 *   present value that does not pass, naming its field
 */
export function planDraftDevice(
  draft: DeviceDraft,
  rooms: readonly string[],
  clock: DraftClock,
  catalog?: CatalogLookup,
  stored?: DraftDeviceDocument,
): Unsaved<DraftDeviceDocument> {
  const values = [draft.credential, draft.name, draft.room, draft.spot, draft.serial]
  if (values.every((value) => typed(value) === undefined)) {
    // On the setup code because that is where the form starts: the message is shown on step 1.
    throw new DraftError(
      'credential',
      'draftEmpty',
      'A draft needs at least one value: a setup code, a room, a name, a spot or a serial number.',
    )
  }

  // The same order `checkDraftFields` reports in, so the form and the draft agree on which
  // problem comes first.
  const credential = typed(draft.credential) === undefined ? undefined : credentialOf(draft)
  const installedAt =
    typed(draft.installedAt) === undefined ? undefined : readInstalledAt(draft.installedAt)
  const room =
    typed(draft.room) === undefined ? undefined : matchRoom(readRoomPath(draft.room), rooms)
  const now = clock.now()
  const code =
    credential === undefined
      ? {}
      : { ...credentialFields(credential), ...catalogFor(credential, catalog, now) }

  return {
    _id: stored?._id ?? documentId('device', clock.uuid()),
    ...(stored?._rev === undefined ? {} : { _rev: stored._rev }),
    type: 'device',
    status: 'draft',
    ...present('name', typed(draft.name)),
    ...present('room', room),
    ...code,
    ...keptCatalogue(stored, code),
    ...optionalText('spot', draft.spot),
    ...optionalText('serial', draft.serial),
    ...present('installedAt', installedAt),
    addedAt: stored?.addedAt ?? now,
    disabled: false,
    remarks: stored?.remarks ?? [],
  }
}

/** The catalogue block a stored document carries, or nothing. */
function catalogueOf(stored: DraftDeviceDocument): Partial<CatalogFields> {
  return Object.fromEntries(
    CATALOG_FIELD_KEYS.flatMap((key) => (stored[key] === undefined ? [] : [[key, stored[key]]])),
  ) as Partial<CatalogFields>
}

/**
 * The catalogue block a stored draft already held, when the planned document still names the
 * same product and was given no newer answer; nothing otherwise.
 *
 * Why: the add form asks the catalogue only when the code field changes, so a draft reopened
 * offline (or saved before a lookup answered) has no answer in hand. Without this, saving it
 * again or finishing it would drop names that backfill had already found.
 */
function keptCatalogue(
  stored: DraftDeviceDocument | undefined,
  planned: Pick<DeviceDocument, 'vendorId' | 'productId' | 'catalogCheckedAt'>,
): Partial<CatalogFields> {
  const sameProduct =
    stored?.vendorId !== undefined &&
    stored.vendorId === planned.vendorId &&
    stored.productId === planned.productId
  return sameProduct && planned.catalogCheckedAt === undefined ? catalogueOf(stored) : {}
}

/**
 * Finishes a draft: the full `planNewDevice` checks, the draft status gone, the document kept.
 *
 * The id, revision, added date and remarks are the draft's, so finishing updates the one
 * document every replica already has. A catalogue answer the draft already held is kept when
 * the code is still the same product and no newer answer was given; for another code it is
 * dropped, as `planNewDevice` drops an answer about another code.
 *
 * @param draft the form's contents
 * @param rooms every room path the project's devices carry
 * @param clock the wall clock (the uuid is never asked: the draft has its id)
 * @param stored the draft being finished
 * @param catalog the catalogue's answer for this code, when one has arrived
 * @returns the complete device to save, with no status
 * @throws {DraftError} for any unusable field, exactly as `planNewDevice` does
 */
export function planFinishedDevice(
  draft: DeviceDraft,
  rooms: readonly string[],
  clock: DraftClock,
  stored: DraftDeviceDocument,
  catalog?: CatalogLookup,
): Unsaved<DeviceDocument> {
  // The draft's own uuid, so the planned id is already the one kept below.
  const uuid = uuidOf(stored._id) ?? stored._id
  const planned = planNewDevice(draft, rooms, { ...clock, uuid: () => uuid }, catalog)
  return {
    ...planned,
    ...keptCatalogue(stored, planned),
    _id: stored._id,
    ...(stored._rev === undefined ? {} : { _rev: stored._rev }),
    addedAt: stored.addedAt,
    remarks: stored.remarks,
  }
}

/**
 * A draft read back into the form's contents, for reopening it (#358).
 *
 * The setup code as the payload when there is one, since that is the fuller form of it, else
 * the manual code; every absent value as an empty control.
 */
export function draftFormOf(stored: DraftDeviceDocument): Required<DeviceDraft> {
  return {
    credential: stored.payload ?? stored.manualCode ?? '',
    name: stored.name ?? '',
    room: stored.room ?? '',
    spot: stored.spot ?? '',
    serial: stored.serial ?? '',
    installedAt: stored.installedAt ?? '',
  }
}
