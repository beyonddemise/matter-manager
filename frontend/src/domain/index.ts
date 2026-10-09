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
  CATALOG_FIELD_KEYS,
  CATALOG_MISS_RETRY_MS,
  type CatalogFields,
  type CatalogNames,
  catalogFields,
  catalogNames,
  isHttpsUrl,
  manufacturerName,
  needsCatalogLookup,
  TEST_VENDOR_NAME,
  withCatalogBlock,
} from './catalog/copy.js'
export { testVendorAnswer } from './catalog/test-vendor.js'
export type { CatalogLookup } from './catalog/types.js'
export {
  type BrowseOptions,
  browseDevices,
  type DeviceGroup,
} from './documents/browse.js'
export {
  type DeviceFields,
  DRAFT_PROBLEMS,
  type DraftClock,
  DraftError,
  type DraftField,
  type DraftProblem,
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
// Only the types and the error reach the entry point. `readName`, `chooseRoom` and the rest
// are how `planNewDevice` and `planDeviceEdit` agree with each other, not an API for callers:
// a view that validated a name itself would be a second answer to a question `core` already
// answers, which is the whole failure this module was extracted to prevent.
export {
  type DeviceCreation,
  type DeviceDraft,
  planNewDevice,
} from './documents/new-device.js'
export {
  isProjectDocument,
  PROJECT_DOCUMENT_ID,
  type ProjectDocument,
} from './documents/project.js'
export {
  addRemark,
  type RemarkAuthor,
  remarksNewestFirst,
} from './documents/remark.js'
export type {
  CatalogSource,
  DeviceDiscovery,
  DeviceDocument,
  RoomDocument,
  Unsaved,
} from './documents/types.js'
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
  PAYLOAD_PROBLEMS,
  PayloadError,
  type PayloadProblem,
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
  canOwnAnother,
  isPlan,
  isWaitlistPlan,
  LAYOUTS,
  limitFor,
  PLAN_FEATURES,
  PLANS,
  type Plan,
  type PlanFeatures,
  PROJECT_LIMITS,
  planOf,
  planSyncs,
  plansAbove,
  SYNCED_PLANS,
  showsUpgrade,
  withinLimit,
} from './plan.js'
export type { ProjectRole } from './role.js'
export {
  devicesInRoom,
  planRoomDeletion,
  type RoomDeletionPlan,
  type RoomDestination,
  renameRoom,
  reorderRooms,
  roomsInOrder,
} from './rooms/list.js'
export {
  compareRoomPaths,
  isNearDuplicateRoomPath,
  isValidRoomPath,
  isWithinRoom,
  normaliseRoomPath,
  ROOM_PATH_CRUMB,
  ROOM_PATH_SEPARATOR,
  RoomPathError,
  type RoomPathProblem,
  renameRoomPath,
  roomPathBreadcrumb,
  roomPathKey,
  roomPathProblem,
  splitRoomPath,
} from './rooms/path.js'
export {
  type CatalogBearing,
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
export {
  DELETION_MEMORY_DAYS,
  type DeletedRoom,
  type ResurrectedRoom,
  resurrectedRooms,
  worthRemembering,
} from './sync/resurrection.js'
export { foldForComparison } from './text/fold.js'
