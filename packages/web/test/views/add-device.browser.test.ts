import '@awesome.me/webawesome-pro/dist/components/button/button.js'
import '@awesome.me/webawesome-pro/dist/components/callout/callout.js'
import '@awesome.me/webawesome-pro/dist/components/combobox/combobox.js'
import '@awesome.me/webawesome-pro/dist/components/icon/icon.js'
import '@awesome.me/webawesome-pro/dist/components/input/input.js'
import '@awesome.me/webawesome-pro/dist/components/option/option.js'
import type { DeviceDocument, RoomDocument } from '@matter-manager/core'
import { fixture, html, waitUntil } from '@open-wc/testing-helpers'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { AddDeviceView } from '../../src/views/add-device.js'
import '../../src/views/add-device.js'
import { browserDatabase, type TestDatabase } from '../support/browser-database.js'

/** The verified reference device; see `packages/core/test/matter/payload.test.ts`. */
const PAYLOAD = 'MT:Y.K9042C00KA0648G00'
const SHORT_CODE = '34970112332'

let database: TestDatabase

beforeEach(() => {
  database = browserDatabase()
})

afterEach(async () => {
  await database.destroy()
})

/**
 * Builds the form with a database of its own.
 *
 * A test that pre-seeds a room waits for `element.rooms` itself, and must: `planNewDevice`
 * matches against the rooms the view is holding, so submitting before that read finished
 * would create a second copy of a room that already exists — and the test would pass while
 * doing exactly the thing the feature exists to prevent.
 */
async function form(): Promise<AddDeviceView> {
  await Promise.all([
    customElements.whenDefined('wa-input'),
    customElements.whenDefined('wa-combobox'),
    customElements.whenDefined('wa-option'),
  ])
  return (await fixture(
    html`<add-device-view .repositories=${database.repositories}></add-device-view>`,
  )) as AddDeviceView
}

/** Fills a control the way a user's typing leaves it: through the DOM property. */
function fill(element: HTMLElement, field: string, value: string): void {
  const control = element.querySelector(`[data-field="${field}"]`) as { value?: string } | null
  if (control === null) throw new Error(`no control for field "${field}"`)
  control.value = value
}

/**
 * Types a room path, which for a combobox is `inputValue` and not `value`.
 *
 * The distinction is the whole reason this helper exists rather than another `fill`. Setting
 * `value` to a path with no matching option does not select it — the component rejects it and
 * leaves `value` as `null` — so a test using `fill` here would exercise a state no user can
 * produce, and would keep failing while the application was right.
 */
function typeRoom(element: HTMLElement, path: string): void {
  const combobox = element.querySelector('[data-field="room"]') as { inputValue?: string } | null
  if (combobox === null) throw new Error('no room combobox')
  combobox.inputValue = path
}

/** Submits the form and waits for whatever the caller says settles it. */
async function submit(element: HTMLElement, settled: () => boolean | Promise<boolean>) {
  const target = element.querySelector('form')
  target?.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }))
  await waitUntil(settled, 'the form never settled after submit', { timeout: 3000 })
}

const devices = (): Promise<DeviceDocument[]> => database.repositories.devices.list()
const rooms = (): Promise<RoomDocument[]> => database.repositories.rooms.list()

describe('filing a device from a pasted payload', () => {
  it('saves it with the fields the payload carried', async () => {
    const element = await form()
    fill(element, 'credential', PAYLOAD)
    fill(element, 'name', 'Kitchen ceiling light')
    typeRoom(element, 'Ground Floor/Kitchen')

    await submit(element, async () => (await devices()).length === 1)

    // Read back through the repository rather than off the component: a test that asserts
    // against the form it just filled in proves the form, not the save.
    const [device] = await devices()
    expect(device?.name).toBe('Kitchen ceiling light')
    expect(device?.payload).toBe(PAYLOAD)
    expect(device?.vendorId).toBe(0xfff1)
    expect(device?.productId).toBe(0x8000)
  })

  it('defaults the installation date to today', async () => {
    const element = await form()
    fill(element, 'credential', PAYLOAD)
    fill(element, 'name', 'Kitchen ceiling light')
    typeRoom(element, 'Kitchen')

    await submit(element, async () => (await devices()).length === 1)

    const expected = new Date(Date.now() - new Date().getTimezoneOffset() * 60_000)
      .toISOString()
      .slice(0, 10)
    expect((await devices())[0]?.installedAt).toBe(expected)
  })

  it('files a device from a manual pairing code, with no payload invented for it', async () => {
    const element = await form()
    fill(element, 'credential', SHORT_CODE)
    fill(element, 'name', 'Hall sensor')
    typeRoom(element, 'Hall')

    await submit(element, async () => (await devices()).length === 1)

    const [device] = await devices()
    expect(device?.manualCode).toBe(SHORT_CODE)
    expect(device?.payload).toBeUndefined()
  })
})

describe('the room', () => {
  it('creates one inline and points the device at it', async () => {
    const element = await form()
    fill(element, 'credential', PAYLOAD)
    fill(element, 'name', 'Kitchen ceiling light')
    typeRoom(element, 'Ground Floor/Kitchen')

    await submit(element, async () => (await devices()).length === 1)

    const [room] = await rooms()
    expect(room?.path).toBe('Ground Floor/Kitchen')
    expect((await devices())[0]?.roomId).toBe(room?._id)
  })

  it('takes the path from the combobox\'s "Create" option', async () => {
    // The component fires `wa-create` when the user picks "Create X" from the listbox; this
    // exercises the handler that takes it over, which is the half this application owns.
    const element = await form()
    const combobox = element.querySelector('[data-field="room"]') as HTMLElement & {
      value?: string
    }
    combobox.dispatchEvent(
      new CustomEvent('wa-create', {
        detail: { inputValue: '  First Floor / Bathroom ' },
        cancelable: true,
        bubbles: true,
      }),
    )
    await waitUntil(() => combobox.value === 'First Floor/Bathroom')

    fill(element, 'credential', PAYLOAD)
    fill(element, 'name', 'Bathroom light')
    await submit(element, async () => (await devices()).length === 1)

    expect((await rooms())[0]?.path).toBe('First Floor/Bathroom')
  })

  it('takes a room picked from the list', async () => {
    await database.repositories.rooms.save({
      _id: 'room:kitchen',
      type: 'room',
      path: 'Ground Floor/Kitchen',
    })

    const element = await form()
    await waitUntil(() => element.rooms.length === 1, 'the view never read the existing room')
    await element.updateComplete

    // The other half of the control: `value` is what selecting an option leaves behind, and
    // it only sticks because the option is there to select.
    const combobox = element.querySelector('[data-field="room"]') as { value?: string }
    combobox.value = 'Ground Floor/Kitchen'

    fill(element, 'credential', PAYLOAD)
    fill(element, 'name', 'Kitchen ceiling light')
    await submit(element, async () => (await devices()).length === 1)

    expect(await rooms()).toHaveLength(1)
    expect((await devices())[0]?.roomId).toBe('room:kitchen')
  })

  it('reuses an existing room rather than creating a second one', async () => {
    await database.repositories.rooms.save({
      _id: 'room:kitchen',
      type: 'room',
      path: 'Ground Floor/Kitchen',
    })

    const element = await form()
    await waitUntil(() => element.rooms.length === 1, 'the view never read the existing room')

    fill(element, 'credential', PAYLOAD)
    fill(element, 'name', 'Kitchen ceiling light')
    // Typed differently on purpose: the same room to a person reading it, and M1-5's
    // `roomPathKey` is what has to agree.
    typeRoom(element, 'ground floor / KITCHEN')

    await submit(element, async () => (await devices()).length === 1)

    expect(await rooms()).toHaveLength(1)
    expect((await devices())[0]?.roomId).toBe('room:kitchen')
  })
})

describe('refusing a draft', () => {
  it('names what was wrong and creates nothing', async () => {
    const element = await form()
    fill(element, 'credential', 'kitchen lamp')
    fill(element, 'name', 'Kitchen ceiling light')
    typeRoom(element, 'Kitchen')

    await submit(element, () => element.querySelector('[data-error]') !== null)

    expect(element.querySelector('[data-error]')?.textContent).toMatch(/MT:/)
    expect(await devices()).toHaveLength(0)
    // The room too. Writing the room before validating the code would leave a stray room
    // behind every time someone mistyped a label.
    expect(await rooms()).toHaveLength(0)
  })

  it('puts the message beside the control that caused it', async () => {
    const element = await form()
    fill(element, 'credential', PAYLOAD)
    fill(element, 'name', '   ')
    typeRoom(element, 'Kitchen')

    await submit(element, () => element.querySelector('[data-error]') !== null)

    const name = element.querySelector('[data-field="name"]') as { hint?: string }
    expect(name.hint).toMatch(/needs a name/)
  })

  it('leaves what the user typed in place, so nothing has to be re-entered', async () => {
    const element = await form()
    fill(element, 'credential', 'kitchen lamp')
    fill(element, 'name', 'Kitchen ceiling light')
    typeRoom(element, 'Kitchen')

    await submit(element, () => element.querySelector('[data-error]') !== null)

    const name = element.querySelector('[data-field="name"]') as { value?: string }
    expect(name.value).toBe('Kitchen ceiling light')
  })
})

describe('the form itself', () => {
  it('submits from the Save button rather than only from a dispatched event', async () => {
    // The tests above dispatch `submit` directly, which would keep passing if the button were
    // wired to nothing at all. This is the one that says the button works.
    const element = await form()
    fill(element, 'credential', PAYLOAD)
    fill(element, 'name', 'Kitchen ceiling light')
    typeRoom(element, 'Kitchen')

    const save = element.querySelector('wa-button[type="submit"]') as HTMLElement
    save.click()

    await waitUntil(async () => (await devices()).length === 1, 'the Save button saved nothing', {
      timeout: 3000,
    })
  })

  it('renders into the light DOM so global utility classes apply', async () => {
    const element = await form()
    expect(element.shadowRoot).toBeNull()
    expect(element.querySelector('.wa-stack')).not.toBeNull()
  })
})
