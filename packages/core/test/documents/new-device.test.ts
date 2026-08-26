import { describe, expect, it } from 'vitest'
import type { DraftClock, DraftError } from '../../src/documents/draft.js'
import { type DeviceDraft, planNewDevice } from '../../src/documents/new-device.js'
import type { RoomDocument } from '../../src/documents/types.js'

/** The verified reference device; see `matter/credential.test.ts`. */
const PAYLOAD = 'MT:Y.K9042C00KA0648G00'
const LONG_CODE = '749701123365521327687'
const SHORT_CODE = '34970112332'

/** Ids in the order they are asked for: the room first when there is one, then the device. */
const clock = (...uuids: readonly string[]): DraftClock => {
  let index = 0
  return {
    uuid: () => uuids[Math.min(index++, uuids.length - 1)] ?? 'exhausted',
    now: () => '2026-08-26T09:00:00.000Z',
  }
}

const draft = (overrides: Partial<DeviceDraft> = {}): DeviceDraft => ({
  credential: PAYLOAD,
  name: 'Kitchen ceiling light',
  room: 'Ground Floor/Kitchen',
  installedAt: '2026-08-26',
  ...overrides,
})

const KITCHEN: RoomDocument = {
  _id: 'room:kitchen-uuid',
  _rev: '1-abc',
  updatedAt: '2026-08-20T10:00:00.000Z',
  type: 'room',
  path: 'Ground Floor/Kitchen',
}

describe('a device from a payload', () => {
  it('stores everything the payload carried', () => {
    const { device } = planNewDevice(draft(), [KITCHEN], clock('device-uuid'))

    expect(device).toEqual({
      _id: 'device:device-uuid',
      type: 'device',
      name: 'Kitchen ceiling light',
      roomId: KITCHEN._id,
      manualCode: LONG_CODE,
      payload: PAYLOAD,
      vendorId: 0xfff1,
      productId: 0x8000,
      discriminator: 3840,
      installedAt: '2026-08-26',
      addedAt: '2026-08-26T09:00:00.000Z',
      disabled: false,
      remarks: [],
    })
  })

  it('keeps optional free text when it says something', () => {
    const { device } = planNewDevice(
      draft({ spot: '  ceiling, north end  ', serial: ' SN-000123 ' }),
      [KITCHEN],
      clock('device-uuid'),
    )

    expect(device.spot).toBe('ceiling, north end')
    expect(device.serial).toBe('SN-000123')
  })

  it('omits optional free text that is only whitespace, rather than storing an empty string', () => {
    // An empty string is a value someone typed; an absent field is "not recorded". Storing
    // `spot: ''` would make a later "does this device have a spot?" answer yes.
    const { device } = planNewDevice(
      draft({ spot: '   ', serial: '' }),
      [KITCHEN],
      clock('device-uuid'),
    )

    expect(device).not.toHaveProperty('spot')
    expect(device).not.toHaveProperty('serial')
  })
})

describe('a device from a manual pairing code', () => {
  it('records no payload, and no fields the code could not carry', () => {
    const { device } = planNewDevice(
      draft({ credential: SHORT_CODE }),
      [KITCHEN],
      clock('device-uuid'),
    )

    expect(device.manualCode).toBe(SHORT_CODE)
    expect(device).not.toHaveProperty('payload')
    expect(device).not.toHaveProperty('vendorId')
    expect(device).not.toHaveProperty('productId')
    expect(device).not.toHaveProperty('discriminator')
  })

  it('records vendor and product from the 21-digit form, but still no payload', () => {
    const { device } = planNewDevice(
      draft({ credential: LONG_CODE }),
      [KITCHEN],
      clock('device-uuid'),
    )

    expect(device.vendorId).toBe(0xfff1)
    expect(device.productId).toBe(0x8000)
    expect(device).not.toHaveProperty('payload')
    // The full discriminator is the field a manual code cannot supply, and the one a guess
    // would ruin: a reconstructed payload would produce a QR that fails to commission.
    expect(device).not.toHaveProperty('discriminator')
  })
})

describe('the room', () => {
  it('reuses an existing room and plans no new one', () => {
    const creation = planNewDevice(draft(), [KITCHEN], clock('device-uuid'))

    expect(creation.room).toBeUndefined()
    expect(creation.device.roomId).toBe(KITCHEN._id)
  })

  it('matches an existing room the way a person would read it', () => {
    // M1-5 already decided that case and spacing do not make a second room. Deciding it again
    // here would be a second answer to a settled question, and the two would drift.
    const creation = planNewDevice(
      draft({ room: '  ground floor /  KITCHEN ' }),
      [KITCHEN],
      clock('device-uuid'),
    )

    expect(creation.room).toBeUndefined()
    expect(creation.device.roomId).toBe(KITCHEN._id)
  })

  it('plans a new room, normalised, when nothing matches', () => {
    const creation = planNewDevice(
      draft({ room: ' First Floor / Bathroom ' }),
      [KITCHEN],
      clock('room-uuid', 'device-uuid'),
    )

    expect(creation.room).toEqual({
      _id: 'room:room-uuid',
      type: 'room',
      path: 'First Floor/Bathroom',
    })
    expect(creation.device.roomId).toBe('room:room-uuid')
  })

  it('plans a new room when the project has none at all', () => {
    const creation = planNewDevice(draft(), [], clock('room-uuid', 'device-uuid'))

    expect(creation.room?.path).toBe('Ground Floor/Kitchen')
    expect(creation.device.roomId).toBe('room:room-uuid')
  })

  it('refuses a path with a stray separator, naming the room field', () => {
    expect(() => planNewDevice(draft({ room: 'Ground Floor//Kitchen' }), [], clock('a'))).toThrow(
      expect.objectContaining({ name: 'DraftError', field: 'room' }),
    )
  })

  it('refuses a blank room', () => {
    expect(() => planNewDevice(draft({ room: '   ' }), [], clock('a'))).toThrow(
      expect.objectContaining({ field: 'room' }),
    )
  })
})

describe('refusing a draft', () => {
  it('names the credential field when the code is not a code', () => {
    expect(() => planNewDevice(draft({ credential: 'kitchen lamp' }), [], clock('a'))).toThrow(
      expect.objectContaining({ field: 'credential' }),
    )
  })

  it("passes the codec's own message through, so the error names what was wrong", () => {
    let message = ''
    try {
      planNewDevice(draft({ credential: '34970112331' }), [], clock('a'))
    } catch (error) {
      message = (error as Error).message
    }
    expect(message).toMatch(/check digit/i)
  })

  it('keeps the original error as the cause rather than flattening it', () => {
    try {
      planNewDevice(draft({ credential: 'kitchen lamp' }), [], clock('a'))
      expect.unreachable('a draft with no usable code must not plan a device')
    } catch (error) {
      expect((error as DraftError).cause).toBeInstanceOf(Error)
    }
  })

  it('names the name field when the name is only whitespace', () => {
    expect(() => planNewDevice(draft({ name: '  ' }), [KITCHEN], clock('a'))).toThrow(
      expect.objectContaining({ field: 'name' }),
    )
  })

  it('refuses a date that is not written YYYY-MM-DD', () => {
    expect(() =>
      planNewDevice(draft({ installedAt: '26/08/2026' }), [KITCHEN], clock('a')),
    ).toThrow(expect.objectContaining({ field: 'installedAt' }))
  })

  it('refuses a well-formed date that does not exist', () => {
    // `new Date('2026-02-31')` rolls forward to 3 March rather than failing, so the shape
    // check alone would file the device under a date the user never chose.
    expect(() =>
      planNewDevice(draft({ installedAt: '2026-02-31' }), [KITCHEN], clock('a')),
    ).toThrow(expect.objectContaining({ field: 'installedAt' }))
  })

  it('never echoes the setup code in the message it produces', () => {
    let message = ''
    try {
      planNewDevice(draft({ credential: '34970112331' }), [], clock('a'))
    } catch (error) {
      message = (error as Error).message
    }
    expect(message).not.toContain('34970112331')
  })
})
