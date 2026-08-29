import { describe, expect, it } from 'vitest'
import {
  DRAFT_PROBLEMS,
  DraftError,
  type DraftProblem,
  readInstalledAt,
  readName,
  readRoomPath,
} from '../../src/documents/draft.js'
import { type DeviceDraft, planNewDevice } from '../../src/documents/new-device.js'
import { addRemark } from '../../src/documents/remark.js'
import type { DeviceDocument } from '../../src/documents/types.js'
import { PAYLOAD_PROBLEMS } from '../../src/matter/payload.js'

/**
 * `DraftError` says which control is wrong. It now also says **why**, as a code, so that the
 * form can render the reason in the reader's language rather than the English sentence `core`
 * happens to hold (#75).
 *
 * A credential failure forwards the `PayloadProblem` it came from rather than flattening every
 * one of them to "the setup code is wrong". The whole point of the payload codes is that
 * "you typed 12 digits" and "that is a URL, not a setup code" call for different remedies.
 */

const clock = { uuid: () => 'fixed-uuid', now: () => '2026-08-30T00:00:00.000Z' }

const draft = (overrides: Partial<DeviceDraft> = {}): DeviceDraft => ({
  credential: 'MT:Y.K9042C00KA0648G00',
  name: 'Kitchen ceiling light',
  room: 'Ground Floor/Kitchen',
  installedAt: '2026-08-30',
  ...overrides,
})

const device = (): DeviceDocument => ({
  _id: 'device:fixed',
  _rev: '1-abc',
  type: 'device',
  name: 'Lamp',
  roomId: 'room:fixed',
  manualCode: '34970112332',
  installedAt: '2026-08-30',
  addedAt: '2026-08-30T00:00:00.000Z',
  updatedAt: '2026-08-30T00:00:00.000Z',
  disabled: false,
  remarks: [],
})

/** Runs `fn`, requires a `DraftError`, and returns the field and code it names. */
const draftProblemFrom = (fn: () => unknown): { field: string; problem: DraftProblem } => {
  try {
    fn()
  } catch (error) {
    if (error instanceof DraftError) return { field: error.field, problem: error.problem }
    throw error
  }
  throw new Error('expected the call to throw a DraftError, but it returned')
}

describe('a rejected field names why it was rejected', () => {
  it('reports an empty name', () => {
    expect(draftProblemFrom(() => readName('  '))).toEqual({
      field: 'name',
      problem: 'nameEmpty',
    })
  })

  it('reports an empty room path', () => {
    expect(draftProblemFrom(() => readRoomPath('  '))).toEqual({
      field: 'room',
      problem: 'roomPathEmpty',
    })
  })

  it('separates a stray separator from an empty path, as the remedies differ', () => {
    expect(draftProblemFrom(() => readRoomPath('Ground Floor//Kitchen'))).toEqual({
      field: 'room',
      problem: 'roomPathEmptySegment',
    })
  })

  it('reports a date that is not a calendar date', () => {
    expect(draftProblemFrom(() => readInstalledAt('2026-02-31'))).toEqual({
      field: 'installedAt',
      problem: 'installedAtNotACalendarDate',
    })
  })

  it('reports a remark with nothing in it', () => {
    expect(
      draftProblemFrom(() => addRemark(device(), '   ', { sub: 'local', name: 'Ada' }, clock)),
    ).toEqual({ field: 'remark', problem: 'remarkEmpty' })
  })
})

describe('a credential failure keeps the reason it failed for', () => {
  it('forwards the payload code rather than flattening it', () => {
    expect(
      draftProblemFrom(() => planNewDevice(draft({ credential: 'kitchen lamp' }), [], clock)),
    ).toEqual({ field: 'credential', problem: 'notASetupCode' })
  })

  it('tells an empty field apart from an unreadable one', () => {
    expect(draftProblemFrom(() => planNewDevice(draft({ credential: '' }), [], clock))).toEqual({
      field: 'credential',
      problem: 'emptySetupCode',
    })
  })

  it('reaches a code produced deep inside the manual pairing code reader', () => {
    expect(
      draftProblemFrom(() => planNewDevice(draft({ credential: '12345678901' }), [], clock)),
    ).toEqual({ field: 'credential', problem: 'manualCodeCheckDigit' })
  })
})

describe('the union', () => {
  it('contains every payload code, so a credential failure always has one', () => {
    for (const problem of PAYLOAD_PROBLEMS) expect(DRAFT_PROBLEMS).toContain(problem)
  })

  it('has no member the form itself cannot produce', () => {
    // Only the form's own codes are checked here. The payload half is proved reachable in
    // `matter/problems.test.ts`, and three of those are encoding failures a *reader* cannot
    // reach at all — they are in this union because the credential path forwards whatever it
    // is given, not because a draft can produce them.
    const own = DRAFT_PROBLEMS.filter(
      (problem) => !(PAYLOAD_PROBLEMS as readonly string[]).includes(problem),
    )
    const reached = new Set([
      draftProblemFrom(() => readName('  ')).problem,
      draftProblemFrom(() => readRoomPath('  ')).problem,
      draftProblemFrom(() => readRoomPath('a//b')).problem,
      draftProblemFrom(() => readInstalledAt('2026-02-31')).problem,
      draftProblemFrom(() => addRemark(device(), ' ', { sub: 'local', name: 'Ada' }, clock))
        .problem,
    ])
    expect([...own].sort()).toEqual([...reached].sort())
  })
})
