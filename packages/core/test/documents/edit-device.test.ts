import { describe, expect, it } from 'vitest'
import type { DraftError } from '../../src/documents/draft.js'
import { planDeviceEdit, setDeviceDisabled } from '../../src/documents/edit-device.js'
import type { DeviceDocument, RoomDocument } from '../../src/documents/types.js'

const KITCHEN: RoomDocument = {
  _id: 'room:kitchen',
  _rev: '1-a',
  updatedAt: '2026-08-01T00:00:00.000Z',
  type: 'room',
  path: 'Ground Floor/Kitchen',
}

const HALL: RoomDocument = {
  _id: 'room:hall',
  _rev: '1-b',
  updatedAt: '2026-08-01T00:00:00.000Z',
  type: 'room',
  path: 'Ground Floor/Hall',
}

/**
 * A device filed from the verified reference payload; see `matter/credential.test.ts`.
 *
 * Every derived field is present, because the thing most worth asserting about an edit is what
 * it does *not* touch.
 */
const DEVICE: DeviceDocument = {
  _id: 'device:one',
  _rev: '3-c',
  updatedAt: '2026-08-20T10:00:00.000Z',
  type: 'device',
  name: 'Ceiling light',
  roomId: KITCHEN._id,
  spot: 'ceiling, north end',
  manualCode: '34970112332',
  payload: 'MT:Y.K9042C00KA0648G00',
  vendorId: 0xfff1,
  productId: 0x8001,
  discriminator: 3840,
  serial: 'SN-1',
  installedAt: '2026-08-20',
  addedAt: '2026-08-20T09:59:00.000Z',
  disabled: false,
  remarks: [
    {
      id: 'remark:1',
      text: 'Behind the ceiling rose.',
      authorSub: 'sub-1',
      authorName: 'Someone',
      createdAt: '2026-08-20T10:00:00.000Z',
    },
  ],
}

const FIELDS = {
  name: 'Ceiling light',
  room: 'Ground Floor/Kitchen',
  spot: 'ceiling, north end',
  serial: 'SN-1',
  installedAt: '2026-08-20',
}

const uuid =
  (value = 'new-room-uuid') =>
  () =>
    value

describe('planDeviceEdit', () => {
  it('renames a device without touching anything else', () => {
    const { room, device } = planDeviceEdit(
      DEVICE,
      { ...FIELDS, name: '  Kitchen ceiling light  ' },
      [KITCHEN],
      uuid(),
    )

    expect(room).toBeUndefined()
    expect(device.name).toBe('Kitchen ceiling light')
    expect(device._id).toBe(DEVICE._id)
    expect(device._rev).toBe(DEVICE._rev)
    expect(device.roomId).toBe(KITCHEN._id)
    expect(device.addedAt).toBe(DEVICE.addedAt)
    expect(device.remarks).toEqual(DEVICE.remarks)
  })

  it('leaves the credential exactly as it was', () => {
    // The reason the setup code is not an editable field at all: these five agree with each
    // other or the QR silently fails to commission. An edit must not be able to separate them.
    const { device } = planDeviceEdit(DEVICE, { ...FIELDS, name: 'Renamed' }, [KITCHEN], uuid())

    expect(device.manualCode).toBe(DEVICE.manualCode)
    expect(device.payload).toBe(DEVICE.payload)
    expect(device.vendorId).toBe(DEVICE.vendorId)
    expect(device.productId).toBe(DEVICE.productId)
    expect(device.discriminator).toBe(DEVICE.discriminator)
  })

  it('does not carry the repository stamp back in', () => {
    // `updatedAt` is half of the conflict merge's total order (ADR 0010) and the repository
    // owns it. A document written with the stamp it was read at loses every future conflict.
    const { device } = planDeviceEdit(DEVICE, FIELDS, [KITCHEN], uuid())

    expect(device).not.toHaveProperty('updatedAt')
  })

  it('moves a device into another existing room without creating one', () => {
    const { room, device } = planDeviceEdit(
      DEVICE,
      { ...FIELDS, room: 'Ground Floor/Hall' },
      [KITCHEN, HALL],
      uuid(),
    )

    expect(room).toBeUndefined()
    expect(device.roomId).toBe(HALL._id)
  })

  it('matches the target room by key, not by string', () => {
    // Otherwise moving a device into `ground floor / hall` would create a *second* room with
    // the same path — the duplicate M1-5 and M2-5 exist to prevent.
    const { room, device } = planDeviceEdit(
      DEVICE,
      { ...FIELDS, room: 'ground floor / hall' },
      [KITCHEN, HALL],
      uuid(),
    )

    expect(room).toBeUndefined()
    expect(device.roomId).toBe(HALL._id)
  })

  it('plans the room first when the device moves somewhere new', () => {
    const { room, device } = planDeviceEdit(
      DEVICE,
      { ...FIELDS, room: 'First Floor / Study' },
      [KITCHEN, HALL],
      uuid('study'),
    )

    expect(room).toEqual({ _id: 'room:study', type: 'room', path: 'First Floor/Study' })
    expect(device.roomId).toBe('room:study')
  })

  it('keeps a disabled device disabled', () => {
    // Renaming something is not a decision to put it back into service, and a rename that
    // silently re-enabled a device would be an application that undoes a deliberate act.
    const disabled: DeviceDocument = {
      ...DEVICE,
      disabled: true,
      disabledAt: '2026-08-21T08:00:00.000Z',
    }

    const { device } = planDeviceEdit(disabled, { ...FIELDS, name: 'Renamed' }, [KITCHEN], uuid())

    expect(device.disabled).toBe(true)
    expect(device.disabledAt).toBe('2026-08-21T08:00:00.000Z')
  })

  it('removes spot and serial when they are cleared rather than storing empty ones', () => {
    const { device } = planDeviceEdit(
      DEVICE,
      { ...FIELDS, spot: '   ', serial: '' },
      [KITCHEN],
      uuid(),
    )

    expect(device).not.toHaveProperty('spot')
    expect(device).not.toHaveProperty('serial')
  })

  it('trims spot and serial when they are given', () => {
    const { device } = planDeviceEdit(
      DEVICE,
      { ...FIELDS, spot: '  under the sink  ', serial: '  SN-2  ' },
      [KITCHEN],
      uuid(),
    )

    expect(device.spot).toBe('under the sink')
    expect(device.serial).toBe('SN-2')
  })

  it('changes the installation date', () => {
    const { device } = planDeviceEdit(
      DEVICE,
      { ...FIELDS, installedAt: '2024-02-29' },
      [KITCHEN],
      uuid(),
    )

    expect(device.installedAt).toBe('2024-02-29')
  })

  it.each([
    ['name', { name: '   ' }],
    ['room', { room: 'Ground Floor//Kitchen' }],
    ['installedAt', { installedAt: '2026-02-31' }],
  ])('refuses an unusable %s, naming the field', (field, override) => {
    let thrown: DraftError | undefined
    try {
      planDeviceEdit(DEVICE, { ...FIELDS, ...override }, [KITCHEN], uuid())
    } catch (error) {
      thrown = error as DraftError
    }

    expect(thrown?.name).toBe('DraftError')
    expect(thrown?.field).toBe(field)
    // Never the device's own code: the message goes on screen and into whatever the user
    // pastes into a bug report.
    expect(thrown?.message).not.toContain(DEVICE.manualCode)
  })
})

describe('setDeviceDisabled', () => {
  it('takes a device out of service and stamps when', () => {
    const updated = setDeviceDisabled(DEVICE, true, () => '2026-08-27T12:00:00.000Z')

    expect(updated.disabled).toBe(true)
    expect(updated.disabledAt).toBe('2026-08-27T12:00:00.000Z')
    expect(updated._rev).toBe(DEVICE._rev)
    expect(updated).not.toHaveProperty('updatedAt')
  })

  it('keeps the payload, which is the whole reason this is not a delete', () => {
    const updated = setDeviceDisabled(DEVICE, true, () => '2026-08-27T12:00:00.000Z')

    expect(updated.payload).toBe(DEVICE.payload)
    expect(updated.manualCode).toBe(DEVICE.manualCode)
  })

  it('keeps the original timestamp when the device is already disabled', () => {
    const already: DeviceDocument = {
      ...DEVICE,
      disabled: true,
      disabledAt: '2026-08-21T08:00:00.000Z',
    }

    const updated = setDeviceDisabled(already, true, () => '2026-08-27T12:00:00.000Z')

    expect(updated.disabledAt).toBe('2026-08-21T08:00:00.000Z')
  })

  it('removes the timestamp when a device goes back into service', () => {
    // A `disabledAt` on a device that is in service is not history, it is a false statement
    // about the present. History is remarks (M2-9) and the audit log (M7).
    const already: DeviceDocument = {
      ...DEVICE,
      disabled: true,
      disabledAt: '2026-08-21T08:00:00.000Z',
    }

    const updated = setDeviceDisabled(already, false, () => '2026-08-27T12:00:00.000Z')

    expect(updated.disabled).toBe(false)
    expect(updated).not.toHaveProperty('disabledAt')
  })

  it('ignores a stray timestamp on a device that is in service', () => {
    const stray: DeviceDocument = {
      ...DEVICE,
      disabled: false,
      disabledAt: '2020-01-01T00:00:00.000Z',
    }

    const updated = setDeviceDisabled(stray, true, () => '2026-08-27T12:00:00.000Z')

    expect(updated.disabledAt).toBe('2026-08-27T12:00:00.000Z')
  })
})
