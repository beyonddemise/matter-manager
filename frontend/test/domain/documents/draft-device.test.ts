import { describe, expect, it } from 'vitest'
import type { CatalogLookup } from '../../../src/domain/catalog/types.js'
import { type DraftClock, DraftError } from '../../../src/domain/documents/draft.js'
import {
  draftFormOf,
  isDraftDevice,
  planDraftDevice,
  planFinishedDevice,
} from '../../../src/domain/documents/draft-device.js'
import type { DeviceDraft } from '../../../src/domain/documents/new-device.js'
import type {
  DeviceDocument,
  DraftDeviceDocument,
  StoredDevice,
} from '../../../src/domain/documents/types.js'

/** The verified reference device; see `matter/credential.test.ts`. */
const PAYLOAD = 'MT:Y.K9042C00KA0648G00'
const LONG_CODE = '749701123365521327687'
const SHORT_CODE = '34970112332'

const clock: DraftClock = { uuid: () => 'draft-uuid', now: () => '2026-11-24T09:00:00.000Z' }
const later: DraftClock = { uuid: () => 'not-asked', now: () => '2026-11-25T10:00:00.000Z' }

/** An empty add form: nothing typed, the date left empty too. */
const form = (overrides: Partial<DeviceDraft> = {}): DeviceDraft => ({
  credential: '',
  name: '',
  room: '',
  installedAt: '',
  ...overrides,
})

/** Runs `fn`, requires a `DraftError`, and returns the field and code it names. */
const refusal = (fn: () => unknown): { field: string; problem: string } => {
  try {
    fn()
  } catch (error) {
    if (error instanceof DraftError) return { field: error.field, problem: error.problem }
    throw error
  }
  throw new Error('expected a DraftError, but the call returned')
}

const stored = (overrides: Partial<DraftDeviceDocument> = {}): DraftDeviceDocument => ({
  _id: 'device:draft-uuid',
  _rev: '1-abc',
  type: 'device',
  status: 'draft',
  name: 'Hall sensor',
  addedAt: '2026-11-24T09:00:00.000Z',
  updatedAt: '2026-11-24T09:00:00.000Z',
  disabled: false,
  remarks: [],
  ...overrides,
})

describe('a draft needs one value and nothing else', () => {
  it('refuses a form with nothing in it, on the setup code', () => {
    expect(refusal(() => planDraftDevice(form(), [], clock))).toEqual({
      field: 'credential',
      problem: 'draftEmpty',
    })
  })

  it('does not count whitespace, or the date alone, as a value', () => {
    // The date is prefilled with today, so on its own it says nothing the person typed.
    expect(
      refusal(() => planDraftDevice(form({ name: '  ', installedAt: '2026-11-24' }), [], clock)),
    ).toEqual({ field: 'credential', problem: 'draftEmpty' })
  })

  it.each([
    ['a name', { name: 'Hall sensor' }],
    ['a room', { room: 'Hall' }],
    ['a spot', { spot: 'by the door' }],
    ['a serial number', { serial: 'SN-1' }],
    ['a setup code', { credential: SHORT_CODE }],
  ])('is a draft with only %s', (_label, overrides) => {
    const draft = planDraftDevice(form(overrides), [], clock)
    expect(draft.status).toBe('draft')
    expect(draft._id).toBe('device:draft-uuid')
  })

  it('stores what was given and leaves the rest absent, not empty', () => {
    expect(planDraftDevice(form({ name: ' Hall sensor ' }), [], clock)).toEqual({
      _id: 'device:draft-uuid',
      type: 'device',
      status: 'draft',
      name: 'Hall sensor',
      addedAt: '2026-11-24T09:00:00.000Z',
      disabled: false,
      remarks: [],
    })
  })
})

describe('a draft still refuses a value that is wrong', () => {
  it('refuses a setup code that does not decode, with the payload problem', () => {
    // Why: a stored setup code is a secret held at rest (ADR 0022) and a QR on a label. A
    // half-typed code would be stored as one, so a draft holds a code only once it reads.
    const problem = refusal(() => planDraftDevice(form({ credential: '1234' }), [], clock))
    expect(problem.field).toBe('credential')
    expect(problem.problem).not.toBe('draftEmpty')
  })

  it('refuses a malformed room path', () => {
    expect(refusal(() => planDraftDevice(form({ room: 'Ground Floor/' }), [], clock))).toEqual({
      field: 'room',
      problem: 'roomPathEmptySegment',
    })
  })

  it('refuses a date that does not exist', () => {
    expect(
      refusal(() => planDraftDevice(form({ name: 'Hall', installedAt: '2026-02-31' }), [], clock)),
    ).toEqual({ field: 'installedAt', problem: 'installedAtNotACalendarDate' })
  })
})

describe('what a draft stores', () => {
  it('stores a readable setup code the way a device does, so it is encrypted the same way', () => {
    const draft = planDraftDevice(form({ credential: PAYLOAD }), [], clock)
    expect(draft).toMatchObject({
      manualCode: LONG_CODE,
      payload: PAYLOAD,
      vendorId: 0xfff1,
      productId: 0x8000,
      discriminator: 3840,
    })
  })

  it('files a room under the existing spelling, as a device does (ADR 0021)', () => {
    const draft = planDraftDevice(
      form({ room: 'ground floor/kitchen' }),
      ['Ground Floor/Kitchen'],
      clock,
    )
    expect(draft.room).toBe('Ground Floor/Kitchen')
  })

  it('keeps a valid date, spot and serial', () => {
    expect(
      planDraftDevice(
        form({ name: 'Hall', installedAt: '2026-11-20', spot: ' door ', serial: 'SN' }),
        [],
        clock,
      ),
    ).toMatchObject({ installedAt: '2026-11-20', spot: 'door', serial: 'SN' })
  })

  it('takes a catalogue answer for its own code, and ignores one for another code', () => {
    const answer: CatalogLookup = {
      vendorId: 0xfff1,
      productId: 0x8000,
      source: 'dcl',
      vendor: { name: 'Acme', preferredName: null, legalName: null, landingPageUrl: null },
      product: null,
      fetchedAt: '2026-11-24T09:00:00.000Z',
      stale: false,
    }
    expect(planDraftDevice(form({ credential: PAYLOAD }), [], clock, answer)).toMatchObject({
      vendorName: 'Acme',
      catalogSource: 'found',
    })
    expect(
      planDraftDevice(form({ credential: PAYLOAD }), [], clock, { ...answer, productId: 1 }),
    ).not.toHaveProperty('vendorName')
  })
})

describe('saving a draft again', () => {
  it('updates the same document: same id, revision, added date and remarks', () => {
    const remark = {
      id: 'r1',
      text: 'Ask the owner',
      authorSub: 's',
      authorName: 'A',
      createdAt: '2026-11-24T09:30:00.000Z',
    }
    const again = planDraftDevice(
      form({ name: 'Hall sensor', room: 'Hall' }),
      [],
      later,
      undefined,
      stored({ remarks: [remark] }),
    )
    expect(again).toMatchObject({
      _id: 'device:draft-uuid',
      _rev: '1-abc',
      addedAt: '2026-11-24T09:00:00.000Z',
      remarks: [remark],
      room: 'Hall',
      status: 'draft',
    })
    expect(again).not.toHaveProperty('updatedAt')
  })

  it('drops a value the person has since cleared', () => {
    const again = planDraftDevice(form({ room: 'Hall' }), [], later, undefined, stored())
    expect(again).not.toHaveProperty('name')
  })
})

describe('finishing a draft', () => {
  const complete = form({
    credential: PAYLOAD,
    name: 'Hall sensor',
    room: 'Hall',
    installedAt: '2026-11-24',
  })

  it('runs the full checks: a draft with no room cannot be finished without one', () => {
    expect(
      refusal(() => planFinishedDevice({ ...complete, room: '' }, [], later, stored())),
    ).toEqual({ field: 'room', problem: 'roomPathEmpty' })
  })

  it('clears the status and keeps the document: id, revision, added date, remarks', () => {
    const finished: ReturnType<typeof planFinishedDevice> = planFinishedDevice(
      complete,
      [],
      later,
      stored(),
    )
    expect(finished).not.toHaveProperty('status')
    expect(finished).toMatchObject({
      _id: 'device:draft-uuid',
      _rev: '1-abc',
      addedAt: '2026-11-24T09:00:00.000Z',
      name: 'Hall sensor',
      manualCode: LONG_CODE,
    })
  })

  it('keeps a catalogue answer the draft already had for the same code', () => {
    const block = {
      vendorName: 'Acme',
      catalogCheckedAt: '2026-11-24T09:00:00.000Z',
      catalogSource: 'found' as const,
    }
    const draft = stored({ manualCode: LONG_CODE, vendorId: 0xfff1, productId: 0x8000, ...block })
    expect(planFinishedDevice(complete, [], later, draft)).toMatchObject(block)
    // Another code: the old answer is about another product, so it goes.
    expect(
      planFinishedDevice({ ...complete, credential: SHORT_CODE }, [], later, draft),
    ).not.toHaveProperty('vendorName')
  })
})

describe('reading a draft back into the form', () => {
  it('gives the payload when there is one, else the manual code, else nothing', () => {
    expect(draftFormOf(stored({ manualCode: LONG_CODE, payload: PAYLOAD })).credential).toBe(
      PAYLOAD,
    )
    expect(draftFormOf(stored({ manualCode: SHORT_CODE })).credential).toBe(SHORT_CODE)
    expect(draftFormOf(stored())).toEqual({
      credential: '',
      name: 'Hall sensor',
      room: '',
      spot: '',
      serial: '',
      installedAt: '',
    })
  })

  it('round-trips through the draft planner', () => {
    const values = form({
      credential: PAYLOAD,
      room: 'Hall',
      spot: 'door',
      installedAt: '2026-11-20',
    })
    const draft = { ...planDraftDevice(values, [], clock), updatedAt: 'x' } as DraftDeviceDocument
    expect(draftFormOf(draft)).toEqual({ ...values, name: '', serial: '' })
  })
})

describe('telling a draft from a device', () => {
  it('is a draft only when the status says so', () => {
    const device = { type: 'device', name: 'Lamp' } as unknown as DeviceDocument
    const devices: StoredDevice[] = [stored(), device]
    expect(devices.map(isDraftDevice)).toEqual([true, false])
  })
})
