/**
 * `@matter-manager/core` - the pure domain layer.
 *
 * Everything exported here is a function over plain data. No I/O, no DOM, no network, no
 * database. That constraint is load-bearing rather than stylistic: this package holds the
 * logic that can actually be wrong, so it has to be exhaustively testable in milliseconds
 * with no setup, and reusable unchanged by the browser app and the API server alike.
 *
 * If something here needs a browser or a database to test, it is two things tangled
 * together - a pure decision and an impure action. Split them and leave only the decision.
 *
 * @module
 */

export {
  type BrowseOptions,
  browseDevices,
  type DeviceGroup,
} from './documents/browse.js'
// Only the types and the error reach the entry point. `readName`, `chooseRoom` and the rest
// are how `planNewDevice` and `planDeviceEdit` agree with each other, not an API for callers:
// a view that validated a name itself would be a second answer to a question `core` already
// answers, which is the whole failure this module was extracted to prevent.
export {
  type DeviceFields,
  type DraftClock,
  DraftError,
  type DraftField,
} from './documents/draft.js'
export {
  type DeviceUpdate,
  planDeviceEdit,
  setDeviceDisabled,
} from './documents/edit-device.js'
export {
  DOCUMENT_PREFIX,
  type DocumentType,
  documentId,
  documentTypeOf,
  HIGHEST_ID_CHARACTER,
  ID_SEPARATOR,
  idRange,
  uuidOf,
} from './documents/ids.js'
export {
  type DeviceCreation,
  type DeviceDraft,
  planNewDevice,
} from './documents/new-device.js'
export {
  addRemark,
  type RemarkAuthor,
  remarksNewestFirst,
} from './documents/remark.js'
export type { DeviceDocument, RoomDocument, Unsaved } from './documents/types.js'
export {
  ACTIONS,
  type Action,
  ALLOW,
  can,
  evaluate,
  type Plan,
  POLICIES,
  type Policy,
  type Principal,
  type ProjectRef,
} from './entitlements/can.js'
export { BASE38_ALPHABET, Base38Error, decodeBase38, encodeBase38 } from './matter/base38.js'
export { type DeviceCredential, readCredential } from './matter/credential.js'
export {
  deriveManualCode,
  type ManualCode,
  type ManualCodeInput,
  parseManualCode,
} from './matter/manual-code.js'
export {
  FORBIDDEN_PASSCODES,
  isValidPasscode,
  MAX_PASSCODE,
  MIN_PASSCODE,
  type PasscodeProblem,
  passcodeProblem,
} from './matter/passcode.js'
export {
  type CustomFlow,
  type DiscoveryCapabilities,
  decodePayload,
  encodePayload,
  type OnboardingPayload,
  PAYLOAD_PREFIX,
  PayloadError,
} from './matter/payload.js'
export { isVerhoeffValid, VerhoeffError, verhoeffCheckDigit } from './matter/verhoeff.js'
export {
  AVERY_5160,
  AVERY_L7160,
  AVERY_L7163,
  FIRST_LABEL,
  LABEL_SAFE_INSET,
  LABEL_STOCKS,
  type LabelPage,
  type LabelStart,
  type LabelStock,
  type LabelSubject,
  layoutLabels,
  MM,
  type PlacedLabel,
} from './pdf/labels.js'
export {
  A4,
  type Block,
  type EntryBlock,
  entriesOf,
  type HeadingBlock,
  layoutInventory,
  type Page,
  type PageGeometry,
} from './pdf/layout.js'
export {
  countSelected,
  type ExportSelection,
  selectForExport,
} from './pdf/selection.js'
export {
  isNearDuplicateRoomPath,
  isValidRoomPath,
  isWithinRoom,
  normaliseRoomPath,
  ROOM_PATH_SEPARATOR,
  RoomPathError,
  type RoomPathProblem,
  renameRoomPath,
  roomPathKey,
  roomPathProblem,
  splitRoomPath,
} from './rooms/path.js'
export {
  compareRevisions,
  latestRevision,
  mergeDevice,
  mergeRemarks,
  mergeRoom,
  type Remark,
  type RemarkBearing,
  type Revision,
  type RoomRevision,
  UNASSIGNED_ROOM_PREFIX,
} from './sync/merge.js'
export { foldForComparison } from './text/fold.js'
