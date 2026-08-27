import { describe, expect, it } from 'vitest'
import * as core from '../src/index.js'

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
  ['InvitationError', 'function'],
  ['TransferError', 'function'],
  ['MembershipError', 'function'],
  ['planNewDevice', 'function'],
  ['planDeviceEdit', 'function'],
  ['setDeviceDisabled', 'function'],
  ['addRemark', 'function'],
  ['remarksNewestFirst', 'function'],
  ['browseDevices', 'function'],
  // base38
  ['BASE38_ALPHABET', 'string'],
  ['Base38Error', 'function'],
  ['decodeBase38', 'function'],
  ['encodeBase38', 'function'],
  // payload
  ['PAYLOAD_PREFIX', 'string'],
  ['PayloadError', 'function'],
  ['decodePayload', 'function'],
  ['encodePayload', 'function'],
  // credential
  ['readCredential', 'function'],
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
  ['UNASSIGNED_ROOM_PREFIX', 'string'],
  ['compareRevisions', 'function'],
  ['latestRevision', 'function'],
  ['mergeDevice', 'function'],
  ['mergeRemarks', 'function'],
  ['mergeRoom', 'function'],
  // entitlements
  ['ACTIONS', 'object'],
  ['INVITATION_LIFETIME', 'number'],
  ['TRANSFER_LIFETIME', 'number'],
  ['PROJECT_ROLES', 'object'],
  ['ALLOW', 'function'],
  ['can', 'function'],
  ['evaluate', 'function'],
  ['POLICIES', 'object'],
  // room paths
  ['ROOM_PATH_SEPARATOR', 'string'],
  ['RoomPathError', 'function'],
  ['isNearDuplicateRoomPath', 'function'],
  ['foldEmail', 'function'],
  ['grantRole', 'function'],
  ['isOpen', 'function'],
  ['isOwner', 'function'],
  ['isValidRoomPath', 'function'],
  ['isWithinRoom', 'function'],
  ['acceptable', 'function'],
  ['applyTransfer', 'function'],
  ['canManageMembers', 'function'],
  ['canWrite', 'function'],
  ['narrowsAccess', 'function'],
  ['normaliseRoomPath', 'function'],
  ['ownerOf', 'function'],
  ['planInvitation', 'function'],
  ['planTransfer', 'function'],
  ['redeemable', 'function'],
  ['securityFor', 'function'],
  ['renameRoomPath', 'function'],
  ['revokeAccess', 'function'],
  ['roleOf', 'function'],
  ['roomPathKey', 'function'],
  ['roomPathProblem', 'function'],
  ['splitRoomPath', 'function'],
]

describe('the public entry point', () => {
  it.each(EXPECTED.map(([name, kind]) => [name, kind]))('exports %s as a %s', (name, kind) => {
    expect(core[name as keyof typeof core]).toBeDefined()
    expect(typeof core[name as keyof typeof core]).toBe(kind)
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

  it('answers an entitlement question', () => {
    expect(core.can({ sub: 'auth0|x', plan: 'free' }, 'pdf.export')).toBe(true)
  })

  it('exposes errors as constructible classes, not bare objects', () => {
    // `instanceof` across a module boundary is what callers actually write in a catch block.
    expect(() => core.decodePayload('nope')).toThrow(core.PayloadError)
    expect(() => core.decodeBase38('$')).toThrow(core.Base38Error)
    expect(() => core.renameRoomPath('a', '', 'b')).toThrow(core.RoomPathError)
  })
})
