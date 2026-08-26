import '@awesome.me/webawesome-pro/dist/components/button/button.js'
import '@awesome.me/webawesome-pro/dist/components/callout/callout.js'
import '@awesome.me/webawesome-pro/dist/components/combobox/combobox.js'
import '@awesome.me/webawesome-pro/dist/components/icon/icon.js'
import '@awesome.me/webawesome-pro/dist/components/input/input.js'
import '@awesome.me/webawesome-pro/dist/components/option/option.js'
import type { DeviceDocument, RoomDocument, Unsaved } from '@matter-manager/core'
import type { ProjectRepositories } from '@matter-manager/data'
import { fixture, html, waitUntil } from '@open-wc/testing-helpers'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { EditDeviceView } from '../../src/views/edit-device.js'
import '../../src/views/edit-device.js'
import { browserDatabase, type TestDatabase } from '../support/browser-database.js'

/** The verified reference device; see `packages/core/test/matter/payload.test.ts`. */
const PAYLOAD = 'MT:Y.K9042C00KA0648G00'
const LONG_CODE = '749701123365521327687'
const UUID = '6ba7b810-9dad-11d1-80b4-00c04fd430c8'
const DEVICE_ID = `device:${UUID}`

let database: TestDatabase

beforeEach(() => {
  database = browserDatabase()
})

afterEach(async () => {
  await database.destroy()
})

const lamp = (extra: Partial<DeviceDocument> = {}): Unsaved<DeviceDocument> => ({
  _id: DEVICE_ID,
  type: 'device',
  name: 'Kitchen ceiling light',
  roomId: 'room:kitchen',
  payload: PAYLOAD,
  manualCode: LONG_CODE,
  vendorId: 0xfff1,
  productId: 0x8000,
  discriminator: 3840,
  spot: 'ceiling, north end',
  serial: 'SN-000123',
  installedAt: '2026-08-19',
  addedAt: '2026-08-19T08:00:00.000Z',
  disabled: false,
  remarks: [],
  ...extra,
})

async function seed(device: Unsaved<DeviceDocument> = lamp()): Promise<void> {
  await database.repositories.rooms.save({
    _id: 'room:kitchen',
    type: 'room',
    path: 'Ground Floor/Kitchen',
  })
  await database.repositories.rooms.save({
    _id: 'room:hall',
    type: 'room',
    path: 'Ground Floor/Hall',
  })
  await database.repositories.devices.save(device)
}

/** The real repositories, with every device write refused - a full disk, a locked database. */
function refusingWrites(): ProjectRepositories {
  const real = database.repositories
  return {
    ...real,
    devices: {
      ...real.devices,
      save: async () => {
        throw new Error('storage refused the write')
      },
    },
  }
}

async function form(
  uuid = UUID,
  repositories: ProjectRepositories = database.repositories,
): Promise<EditDeviceView> {
  await Promise.all([
    customElements.whenDefined('wa-input'),
    customElements.whenDefined('wa-combobox'),
    customElements.whenDefined('wa-option'),
  ])
  const element = (await fixture(
    html`<edit-device-view uuid=${uuid} .repositories=${repositories}></edit-device-view>`,
  )) as EditDeviceView
  await waitUntil(() => element.loaded, 'the edit form never finished its read')
  await element.updateComplete
  return element
}

/** What a control currently shows. The point of most of these tests is that this is prefilled. */
function shown(element: HTMLElement, field: string): string {
  const control = element.querySelector(`[data-field="${field}"]`) as { value?: unknown } | null
  return typeof control?.value === 'string' ? control.value : ''
}

function fill(element: HTMLElement, field: string, value: string): void {
  const control = element.querySelector(`[data-field="${field}"]`) as { value?: string } | null
  if (control === null) throw new Error(`no control for field "${field}"`)
  control.value = value
}

/**
 * Types a room path, which for a combobox is `inputValue` and not `value`.
 *
 * Setting `value` to a path with no matching option does not select it — the component
 * rejects it and leaves `value` as `null` — so a test using `fill` here would exercise a state
 * no user can produce. See lesson L22.
 */
function typeRoom(element: HTMLElement, path: string): void {
  const combobox = element.querySelector('[data-field="room"]') as { inputValue?: string } | null
  if (combobox === null) throw new Error('no room combobox')
  combobox.inputValue = path
}

async function submit(element: HTMLElement, settled: () => boolean | Promise<boolean>) {
  element
    .querySelector('form')
    ?.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }))
  await waitUntil(settled, 'the form never settled after submit', { timeout: 3000 })
}

const stored = async (): Promise<DeviceDocument> => {
  const device = await database.repositories.devices.get(DEVICE_ID)
  if (device === undefined) throw new Error('the device is gone')
  return device
}
const rooms = (): Promise<RoomDocument[]> => database.repositories.rooms.list()

describe('opening the edit form', () => {
  it('shows what is already recorded', async () => {
    await seed()
    const element = await form()

    expect(shown(element, 'name')).toBe('Kitchen ceiling light')
    expect(shown(element, 'spot')).toBe('ceiling, north end')
    expect(shown(element, 'serial')).toBe('SN-000123')
    expect(shown(element, 'installed-at')).toBe('2026-08-19')
    expect(shown(element, 'room')).toBe('Ground Floor/Kitchen')
  })

  it('offers no way to change the setup code', async () => {
    // The derived fields — payload, vendor, product, discriminator — agree with the pairing
    // code or the QR silently fails to commission. There is no control that can separate them.
    await seed()
    const element = await form()

    expect(element.querySelector('[data-field="credential"]')).toBeNull()
    expect(element.querySelector('[data-manual-code]')?.textContent?.trim()).toBe(LONG_CODE)
  })

  it('says so when there is no such device', async () => {
    await seed()
    const element = await form('11111111-2222-3333-4444-555555555555')

    expect(element.querySelector('form')).toBeNull()
    expect(element.textContent).toContain('Device not found')
  })
})

describe('saving an edit', () => {
  it('renames the device and leaves its code alone', async () => {
    await seed()
    const element = await form()
    fill(element, 'name', 'Kitchen spotlight')

    await submit(element, async () => (await stored()).name === 'Kitchen spotlight')

    const device = await stored()
    expect(device.payload).toBe(PAYLOAD)
    expect(device.manualCode).toBe(LONG_CODE)
    expect(device.discriminator).toBe(3840)
    expect(device.addedAt).toBe('2026-08-19T08:00:00.000Z')
  })

  it('moves the device into another existing room without creating one', async () => {
    await seed()
    const before = (await rooms()).length
    const element = await form()
    typeRoom(element, 'Ground Floor/Hall')

    await submit(element, async () => (await stored()).roomId === 'room:hall')

    expect((await rooms()).length).toBe(before)
  })

  it('creates the room when the device is moved somewhere new', async () => {
    await seed()
    const element = await form()
    typeRoom(element, 'First Floor/Study')

    await submit(element, async () => (await stored()).roomId !== 'room:kitchen')

    const study = (await rooms()).find((room) => room.path === 'First Floor/Study')
    expect(study).toBeDefined()
    expect((await stored()).roomId).toBe(study?._id)
  })

  it('removes a spot that was cleared rather than storing an empty one', async () => {
    await seed()
    const element = await form()
    fill(element, 'spot', '')

    await submit(element, async () => (await stored()).spot === undefined)

    expect(await stored()).not.toHaveProperty('spot')
  })

  it('keeps a disabled device disabled', async () => {
    await seed(lamp({ disabled: true, disabledAt: '2026-08-20T09:00:00.000Z' }))
    const element = await form()
    fill(element, 'name', 'Renamed while out of service')

    await submit(element, async () => (await stored()).name === 'Renamed while out of service')

    const device = await stored()
    expect(device.disabled).toBe(true)
    expect(device.disabledAt).toBe('2026-08-20T09:00:00.000Z')
  })

  it('reports an unusable field without writing anything', async () => {
    await seed()
    const element = await form()
    const before = await stored()
    fill(element, 'name', '   ')

    await submit(element, () => element.querySelector('[data-error]') !== null)

    expect((await stored())._rev).toBe(before._rev)
  })

  it('keeps what the user typed when a field is rejected', async () => {
    // The one thing a validation error must not do. Binding `.value` in the template would
    // make Lit rewrite every control on the error re-render, silently discarding the edit.
    await seed()
    const element = await form()
    fill(element, 'name', '   ')
    fill(element, 'serial', 'SN-EDITED')

    await submit(element, () => element.querySelector('[data-error]') !== null)
    await element.updateComplete

    expect(shown(element, 'serial')).toBe('SN-EDITED')
  })
})

describe('navigating between devices', () => {
  it('loads the device the route now names', async () => {
    // The shell reuses one element and updates its `uuid`. Without a reload on that change
    // this form would be editing the device the user navigated away from — and unlike the
    // read-only device page, it would then *write* it.
    const other = '11111111-2222-3333-4444-555555555555'
    await seed()
    await database.repositories.devices.save(
      lamp({ _id: `device:${other}`, name: 'Hall sensor', roomId: 'room:hall' }),
    )

    const element = await form()
    element.uuid = other

    await waitUntil(
      () => shown(element, 'name') === 'Hall sensor',
      'the form kept showing the device it came from',
      { timeout: 3000 },
    )
    expect(shown(element, 'room')).toBe('Ground Floor/Hall')
  })
})

describe('a write storage refuses', () => {
  it('stays on the form and says so, rather than navigating as though it saved', async () => {
    await seed()
    const element = await form(UUID, refusingWrites())
    fill(element, 'name', 'Kitchen spotlight')

    await submit(element, () => element.querySelector('[data-save-failed]') !== null)

    expect((await stored()).name).toBe('Kitchen ceiling light')
    // The one thing that must survive a failed save is the work the user just did.
    expect(shown(element, 'name')).toBe('Kitchen spotlight')
  })

  it('says nothing about a field, because no field was wrong', async () => {
    // A storage failure dressed up as a validation error sends the user hunting through
    // controls that were all correct.
    await seed()
    const element = await form(UUID, refusingWrites())

    await submit(element, () => element.querySelector('[data-save-failed]') !== null)

    expect(element.querySelector('[data-error]')).toBeNull()
  })
})
