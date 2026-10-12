import { describe, expect, it } from 'vitest'
import * as core from '../../src/domain/index.js'

/**
 * The contract every other package consumes.
 *
 * Every other test file imports the module it is testing directly — `../../src/rooms/path.js`
 * and so on — which is right for testing behaviour but means `src/index.ts` is exercised by
 * nothing at all. An export that is missing, renamed or misspelled there breaks `web`, `data`
 * and `api` while the entire suite stays green, because no test ever traverses the file that
 * is actually broken.
 *
 * So this file imports through the entry point and nowhere else. It is deliberately shallow:
 * the behaviour is proved next to each module, and repeating it here would only mean two
 * places to update. What it proves is that the names exist, are the kind of thing they claim
 * to be, and reach the implementation.
 */

/** Every runtime export, with the shape callers depend on. Types are checked by `tsc`, not here. */
const EXPECTED: ReadonlyArray<
  readonly [keyof typeof core, 'function' | 'string' | 'number' | 'object']
> = [
  // documents
  ['DOCUMENT_PREFIX', 'object'],
  ['documentId', 'function'],
  ['documentTypeOf', 'function'],
  ['HIGHEST_ID_CHARACTER', 'string'],
  ['ID_SEPARATOR', 'string'],
  ['idRange', 'function'],
  ['uuidOf', 'function'],
  ['DraftError', 'function'],
  ['DRAFT_PROBLEMS', 'object'],
  ['planNewDevice', 'function'],
  ['planDeviceEdit', 'function'],
  ['setDeviceDisabled', 'function'],
  ['addRemark', 'function'],
  ['resurrectedRooms', 'function'],
  ['worthRemembering', 'function'],
  ['DELETION_MEMORY_DAYS', 'number'],
  ['remarksNewestFirst', 'function'],
  ['browseDevices', 'function'],
  ['PROJECT_DOCUMENT_ID', 'string'],
  ['isProjectDocument', 'function'],
  // plan
  ['PROJECT_LIMITS', 'object'],
  ['SYNCED_PLANS', 'object'],
  ['LAYOUTS', 'object'],
  ['withinLimit', 'function'],
  ['isPlan', 'function'],
  ['planOf', 'function'],
  ['limitFor', 'function'],
  ['planSyncs', 'function'],
  ['canOwnAnother', 'function'],
  ['showsUpgrade', 'function'],
  ['PLANS', 'object'],
  ['PLAN_FEATURES', 'object'],
  ['plansAbove', 'function'],
  ['isWaitlistPlan', 'function'],
  // base38
  ['BASE38_ALPHABET', 'string'],
  ['Base38Error', 'function'],
  ['decodeBase38', 'function'],
  ['encodeBase38', 'function'],
  // payload
  ['PAYLOAD_PREFIX', 'string'],
  ['PAYLOAD_PROBLEMS', 'object'],
  ['PayloadError', 'function'],
  ['decodePayload', 'function'],
  ['encodePayload', 'function'],
  // credential
  ['readCredential', 'function'],
  // catalogue
  ['CATALOG_FIELD_KEYS', 'object'],
  ['CATALOG_MISS_RETRY_MS', 'number'],
  ['TEST_VENDOR_NAME', 'string'],
  ['catalogFields', 'function'],
  ['catalogNames', 'function'],
  ['isHttpsUrl', 'function'],
  ['manufacturerName', 'function'],
  ['needsCatalogLookup', 'function'],
  ['testVendorAnswer', 'function'],
  ['withCatalogBlock', 'function'],
  // manual code
  ['deriveManualCode', 'function'],
  ['parseManualCode', 'function'],
  // verhoeff
  ['isVerhoeffValid', 'function'],
  ['VerhoeffError', 'function'],
  ['verhoeffCheckDigit', 'function'],
  // passcode
  ['FORBIDDEN_PASSCODES', 'object'],
  ['isValidPasscode', 'function'],
  ['MAX_PASSCODE', 'number'],
  ['MIN_PASSCODE', 'number'],
  ['passcodeProblem', 'function'],
  // text
  ['foldForComparison', 'function'],
  // pdf layout
  ['A4', 'object'],
  ['layoutInventory', 'function'],
  ['entriesOf', 'function'],
  ['selectForExport', 'function'],
  ['layoutLabels', 'function'],
  ['LABEL_STOCKS', 'object'],
  ['AVERY_L7160', 'object'],
  ['AVERY_L7163', 'object'],
  ['AVERY_5160', 'object'],
  ['FIRST_LABEL', 'object'],
  ['LABEL_SAFE_INSET', 'number'],
  ['MM', 'number'],
  ['countSelected', 'function'],
  // conflict merge
  ['compareRevisions', 'function'],
  ['latestRevision', 'function'],
  ['mergeDevice', 'function'],
  ['mergeRemarks', 'function'],
  ['mergeRoom', 'function'],
  // room paths
  ['ROOM_PATH_SEPARATOR', 'string'],
  ['RoomPathError', 'function'],
  // Named here rather than with the conflict merge: two features need the same room, and a
  // second constant with the same value would be two rooms the day somebody changed one.
  ['UNASSIGNED_ROOM_PREFIX', 'string'],
  ['isNearDuplicateRoomPath', 'function'],
  // the room list
  ['devicesInRoom', 'function'],
  ['planRoomDeletion', 'function'],
  ['renameRoom', 'function'],
  ['reorderRooms', 'function'],
  ['roomsInOrder', 'function'],
  ['isValidRoomPath', 'function'],
  ['isWithinRoom', 'function'],
  ['normaliseRoomPath', 'function'],
  ['renameRoomPath', 'function'],
  ['roomPathKey', 'function'],
  ['roomPathProblem', 'function'],
  ['splitRoomPath', 'function'],
  ['compareRoomPaths', 'function'],
  ['ROOM_PATH_CRUMB', 'string'],
  ['roomPathBreadcrumb', 'function'],
]

/**
 * One export, by name, off the namespace.
 *
 * Walking a namespace import dynamically is what `noDynamicNamespaceImportAccess` exists to
 * discourage, and its reason — it defeats tree shaking, so the bundle carries the whole module
 * — is about shipped code. This is a test, it is not bundled, and reaching each export *by
 * name from a list* is the entire mechanism: the point is that the list and the module agree,
 * which named imports cannot express without repeating every name a second time and giving the
 * drift somewhere new to hide.
 *
 * Suppressed once, here, rather than at each of the two call sites — a lint comment per
 * assertion reads as an exception being made twice instead of a decision taken once.
 */
// biome-ignore lint/performance/noDynamicNamespaceImportAccess: see above — a test, not bundled, and the dynamic access is the mechanism
const exported = (name: string): unknown => core[name as keyof typeof core]

describe('the public entry point', () => {
  it.each(EXPECTED.map(([name, kind]) => [name, kind]))('exports %s as a %s', (name, kind) => {
    expect(exported(name as string)).toBeDefined()
    expect(typeof exported(name as string)).toBe(kind)
  })

  it('exports nothing beyond what is listed here', () => {
    // Catches the other direction: an export added without a decision, or a stale one left
    // behind after a module was removed. Failing here means updating the list above, which is
    // the point — the entry point is a contract and should not change by accident.
    expect(Object.keys(core).sort()).toEqual(EXPECTED.map(([name]) => name as string).sort())
  })
})

/**
 * One call per module, through the entry point.
 *
 * A name check alone passes if an export is wired to the wrong module — the symbol exists and
 * has the right type while doing something else entirely. Each of these uses a value already
 * verified in that module's own suite, so a mismatch shows up as a wrong answer rather than a
 * missing name.
 */
describe('the public entry point reaches the implementations', () => {
  it('orders the plans', () => {
    expect(core.plansAbove('member')).toEqual(['pro'])
  })

  it('decides when to ask the catalogue', () => {
    expect(core.needsCatalogLookup({ manualCode: '34970112332' }, new Date())).toBe(false)
  })

  it('decodes a payload', () => {
    expect(core.decodePayload('MT:Y.K9042C00KA0648G00').passcode).toBe(20202021)
  })

  it('round-trips a payload through both directions', () => {
    const payload = 'MT:Y.K9042C00KA0648G00'
    expect(core.encodePayload(core.decodePayload(payload))).toBe(payload)
  })

  it('decodes Base38', () => {
    expect(core.decodeBase38('Y.K9042C00KA0648G00')).toHaveLength(11)
  })

  it('derives a manual pairing code', () => {
    expect(core.deriveManualCode({ discriminator: 3840, passcode: 20202021 })).toBe('34970112332')
  })

  it('parses a manual pairing code', () => {
    expect(core.parseManualCode('34970112332').passcode).toBe(20202021)
  })

  it('computes a Verhoeff check digit', () => {
    expect(core.verhoeffCheckDigit('3497011233')).toBe(2)
  })

  it('judges a passcode', () => {
    expect(core.isValidPasscode(20202021)).toBe(true)
    expect(core.passcodeProblem(11111111)).toBe('forbidden')
  })

  it('handles a room path', () => {
    expect(core.splitRoomPath('Ground Floor/Kitchen')).toEqual(['Ground Floor', 'Kitchen'])
    expect(core.renameRoomPath('Floor 1/Kitchen', 'Floor 1', 'Ground Floor')).toBe(
      'Ground Floor/Kitchen',
    )
  })

  it('merges conflicting revisions', () => {
    const a = { _id: 'device:1', _rev: '1-a', updatedAt: '2026-08-01T00:00:00.000Z', remarks: [] }
    const b = { _id: 'device:1', _rev: '2-b', updatedAt: '2026-08-02T00:00:00.000Z', remarks: [] }
    expect(core.mergeDevice(a, [b])._rev).toBe('2-b')
  })

  it('exposes errors as constructible classes, not bare objects', () => {
    // `instanceof` across a module boundary is what callers actually write in a catch block.
    expect(() => core.decodePayload('nope')).toThrow(core.PayloadError)
    expect(() => core.decodeBase38('$')).toThrow(core.Base38Error)
    expect(() => core.renameRoomPath('a', '', 'b')).toThrow(core.RoomPathError)
  })
})
