import '@awesome.me/webawesome-pro/dist/components/button/button.js'
import '@awesome.me/webawesome-pro/dist/components/callout/callout.js'
import '@awesome.me/webawesome-pro/dist/components/combobox/combobox.js'
import '@awesome.me/webawesome-pro/dist/components/icon/icon.js'
import '@awesome.me/webawesome-pro/dist/components/dialog/dialog.js'
import '@awesome.me/webawesome-pro/dist/components/input/input.js'
import '@awesome.me/webawesome-pro/dist/components/option/option.js'
import { fixture, html, waitUntil } from '@open-wc/testing-helpers'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ProjectRepositories } from '../../../src/data/index.js'
import type { DeviceDocument, RoomDocument } from '../../../src/domain/index.js'
import { BACKFILL_WANTED, type CatalogApi, type LookupOutcome } from '../../../src/ui/catalog.js'
import { ImageScanError } from '../../../src/ui/scan/image.js'
import type { ScanSource } from '../../../src/ui/scan/source.js'
import type { AddDeviceView } from '../../../src/ui/views/add-device.js'
import '../../../src/ui/views/add-device.js'
import '../../../src/ui/views/scan-dialog.js'
import { browserDatabase, type TestDatabase } from '../support/browser-database.js'
import { AQARA_LOOKUP, aqaraPayload, deferred, fakeCatalog } from '../support/catalog.js'

/** The verified reference device; see `test/domain/matter/payload.test.ts`. */
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
 * Deliberately does not wait for the room list. Submitting re-reads the rooms, so a test does
 * not have to synchronise with a read it cannot see — and the test below that submits with no
 * wait at all is the one pinning that.
 */
/** The real repositories, with room writes refused and device writes working. */
function refusingRoomWrites(): ProjectRepositories {
  const real = database.repositories
  return {
    ...real,
    rooms: {
      ...real.rooms,
      save: async () => {
        throw new Error('storage refused the write')
      },
    },
  }
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
  repositories: ProjectRepositories = database.repositories,
  scanSource: ScanSource | undefined = neverAvailable(),
  catalog?: { api: CatalogApi; online?: boolean },
): Promise<AddDeviceView> {
  await Promise.all([
    customElements.whenDefined('wa-input'),
    customElements.whenDefined('wa-combobox'),
    customElements.whenDefined('wa-option'),
  ])
  return (await fixture(
    html`<add-device-view
      .repositories=${repositories}
      .scanSource=${scanSource}
      .catalog=${catalog?.api}
      .signedIn=${() => catalog !== undefined}
      .online=${() => catalog?.online ?? true}
    ></add-device-view>`,
  )) as AddDeviceView
}

/** Types into the setup-code field the way a keyboard does: value, then an `input` event. */
function typeCode(element: HTMLElement, code: string): void {
  fill(element, 'credential', code)
  element
    .querySelector('[data-field="credential"]')
    ?.dispatchEvent(new Event('input', { bubbles: true, composed: true }))
}

const found = (): Promise<LookupOutcome> => Promise.resolve({ kind: 'found', lookup: AQARA_LOOKUP })

/**
 * A scan source that says this browser cannot scan.
 *
 * The default for every test that is not about scanning, and it is the honest default rather
 * than a convenience: CI runs Linux Chromium, which has no `BarcodeDetector`, so "cannot scan"
 * is what the real source answers there. Letting the tests fall through to the real one would
 * mean the form under test differed between a developer's Mac and CI.
 */
/** A one-pixel PNG, as a `File` from a picker. Its bytes never matter: the decoder is faked. */
function pngFile(): File {
  const png = Uint8Array.from(
    atob(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
    ),
    (character) => character.charCodeAt(0),
  )
  return new File([png], 'label.png', { type: 'image/png' })
}

/**
 * Chooses a file the way a person does, by pressing the control and letting it open the input.
 *
 * A `File` cannot be assigned to `input.files` directly, so it goes through a `DataTransfer` -
 * the same trick a drag-and-drop test would use. Dispatching `change` rather than calling the
 * handler keeps this a test of the wiring as well as of the handler.
 */
async function chooseFile(element: AddDeviceView, file: File): Promise<void> {
  await waitUntil(() => element.querySelector('[data-upload]') !== null, 'no upload control')
  const input = element.querySelector('input[type="file"]') as HTMLInputElement
  const transfer = new DataTransfer()
  transfer.items.add(file)
  input.files = transfer.files
  input.dispatchEvent(new Event('change', { bubbles: true }))
}

function neverAvailable(): ScanSource {
  return {
    available: async () => false,
    open: async () => {
      throw new Error('a source that is not available should never be opened')
    },
    read: async () => [],
    close: () => {},
  }
}

/** A scan source that is available, and reads whatever the test tells it to. */
function scanningSource(code: string): ScanSource {
  const canvas = document.createElement('canvas')
  canvas.width = 2
  canvas.height = 2
  const stream = canvas.captureStream(0)
  return {
    available: async () => true,
    open: async () => stream,
    read: async () => [code],
    close: (open: MediaStream) => {
      for (const track of open.getTracks()) track.stop()
    },
  }
}

/** Reads back what a control currently shows. */
function fieldValue(element: HTMLElement, field: string): string {
  const control = element.querySelector(`[data-field="${field}"]`) as { value?: unknown } | null
  return typeof control?.value === 'string' ? control.value : ''
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

/** Picks an option from the list, which is `value` — the other half of the pair above. */
function selectRoom(element: HTMLElement, path: string): void {
  const combobox = element.querySelector('[data-field="room"]') as { value?: string } | null
  if (combobox === null) throw new Error('no room combobox')
  combobox.value = path
}

/** Submits the form and waits for whatever the caller says settles it. */
async function submit(element: HTMLElement, settled: () => boolean | Promise<boolean>) {
  const target = element.querySelector('form')
  target?.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }))
  await waitUntil(settled, 'the form never settled after submit', { timeout: 3000 })
}

const devices = (): Promise<DeviceDocument[]> => database.repositories.devices.list()
const rooms = (): Promise<RoomDocument[]> => database.repositories.rooms.list()

describe('when the existing rooms cannot be read', () => {
  it('says so, and still lets a device be entered', async () => {
    // Not fatal: a room can be typed. But offering no suggestions in silence invites somebody
    // to type "Kitchen" for a project that already has one, and the duplicate outlives the
    // failure that caused it.
    const failing = {
      devices: { list: async () => [], get: async () => undefined, save: async () => undefined },
      rooms: { list: async () => Promise.reject(new Error('indexed_db_went_bad')) },
    } as never

    const element = (await fixture(
      html`<add-device-view .repositories=${failing}></add-device-view>`,
    )) as HTMLElement & { updateComplete: Promise<unknown>; roomsFailed: boolean }
    await waitUntil(() => element.roomsFailed, 'the room read never reported a failure')
    await element.updateComplete

    expect(element.querySelector('[data-rooms-failed]')).not.toBeNull()
    expect(element.querySelector('[data-field="name"]')).not.toBeNull()
  })
})

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

  it('reuses an existing room even when submitted before the first read lands', async () => {
    // The race CodeRabbit found on #74. `firstUpdated` starts the room read asynchronously; a
    // user who types the name of an existing room and saves before it arrives would, if the
    // form planned against the rooms it was holding, get a *second* room with the same path -
    // the exact duplicate this flow exists to prevent, visible only on a slow device where
    // nobody is watching. Submitting with no wait at all is what pins the re-read.
    await database.repositories.rooms.save({
      _id: 'room:kitchen',
      type: 'room',
      path: 'Ground Floor/Kitchen',
    })

    const element = await form()
    expect(element.rooms).toHaveLength(0)

    fill(element, 'credential', PAYLOAD)
    fill(element, 'name', 'Kitchen ceiling light')
    typeRoom(element, 'Ground Floor/Kitchen')
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

  it('follows a change of mind after a room was already picked', async () => {
    // Picking an option syncs the combobox's `inputValue` to that option's label, but typing
    // afterwards leaves `value` on the old selection. Reading `value` whenever it is set — as
    // this form used to — files the device in the room the user just changed their mind about,
    // and nothing on screen says so.
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

    const element = await form()
    await waitUntil(() => element.rooms.length === 2, 'the view never read the existing rooms')

    fill(element, 'credential', PAYLOAD)
    fill(element, 'name', 'Hall sensor')
    selectRoom(element, 'Ground Floor/Kitchen')
    await element.updateComplete
    typeRoom(element, 'Ground Floor/Hall')

    await submit(element, async () => (await devices()).length === 1)

    expect((await devices())[0]?.roomId).toBe('room:hall')
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

describe('a write storage refuses', () => {
  it('stays on the form and says so, rather than navigating as though it saved', async () => {
    // Navigating to a list that does not contain the device is the application saying it
    // saved something it did not - and what it did not save is a code that cannot be recreated.
    const before = window.location.hash
    const element = await form(refusingWrites())
    fill(element, 'credential', PAYLOAD)
    fill(element, 'name', 'Kitchen ceiling light')
    typeRoom(element, 'Ground Floor/Kitchen')

    await submit(element, () => element.querySelector('[data-save-failed]') !== null)

    expect(await devices()).toHaveLength(0)
    expect(window.location.hash).toBe(before)
    expect(fieldValue(element, 'credential')).toBe(PAYLOAD)
  })
})

describe('the order the two documents are written in', () => {
  it('never leaves a device pointing at a room that was not written', async () => {
    // PouchDB has no transactions, so one of the two writes can fail on its own. Room first
    // means the worst case is an empty room, which is harmless and reusable. Device first
    // means a device whose `roomId` names nothing - and the list would file it under "Without
    // a room", which is a device that has quietly lost the location someone recorded for it.
    const element = await form(refusingRoomWrites())
    fill(element, 'credential', PAYLOAD)
    fill(element, 'name', 'Kitchen ceiling light')
    typeRoom(element, 'Ground Floor/Kitchen')

    await submit(element, () => element.querySelector('[data-save-failed]') !== null)

    expect(await devices()).toHaveLength(0)
  })
})

describe('filling the setup code from a picture', () => {
  /** A decoder that reports one code, whatever it is handed. */
  const decodingTo = (payload: string) => async () => [payload]

  /** A decoder that behaves as the real one does for a picture with nothing in it. */
  const findingNothing = () => async () => {
    throw new ImageScanError('no-code')
  }

  it('offers the upload control even where nothing here can scan', async () => {
    // The point of the feature. `neverAvailable()` is the default source, so this is the
    // desktop with no webcam - which today is shown a form that does not mention scanning at
    // all, and is exactly the person who has a photograph of the label instead.
    const element = await form()
    await waitUntil(() => element.scanChecked, 'the scan check never finished')
    await element.updateComplete

    expect(element.querySelector('[data-scan]')).toBeNull()
    expect(element.querySelector('[data-upload]')).not.toBeNull()
  })

  it('puts a code read from a picture into the setup-code field', async () => {
    const element = await form()
    element.decodeImage = decodingTo(PAYLOAD)
    await element.updateComplete

    await chooseFile(element, pngFile())

    await waitUntil(() => fieldValue(element, 'credential') === PAYLOAD, 'the code never arrived')
  })

  it('says so when the picture carries no code', async () => {
    const element = await form()
    element.decodeImage = findingNothing()
    await element.updateComplete

    await chooseFile(element, pngFile())

    await waitUntil(
      () => element.querySelector('[data-upload-problem]') !== null,
      'nothing said the picture had no code in it',
    )
  })
})

describe('filling the setup code with the camera', () => {
  it('offers no scan control at all when nothing can scan', async () => {
    // Not a disabled button, and not one that explains itself when pressed. A desktop with no
    // camera - or Chromium on Linux, which has no BarcodeDetector - should show a form that
    // simply does not mention scanning.
    const element = await form()
    await waitUntil(() => element.scanChecked, 'the scan check never finished')
    await element.updateComplete

    expect(element.querySelector('[data-scan]')).toBeNull()
  })

  it('offers it when the browser can', async () => {
    const element = await form(database.repositories, scanningSource(PAYLOAD))
    await waitUntil(() => element.querySelector('[data-scan]') !== null, 'no scan control')
  })

  it('puts the scanned code into the setup-code field', async () => {
    // The whole point of the story: the camera is one more way to fill the field the form
    // already has, not a second flow with a second idea of what a setup code is.
    const element = await form(database.repositories, scanningSource(PAYLOAD))
    await waitUntil(() => element.querySelector('[data-scan]') !== null)
    ;(element.querySelector('[data-scan]') as HTMLElement).click()

    await waitUntil(() => fieldValue(element, 'credential') === PAYLOAD, 'the code never arrived')
  })

  it('files a device from a scanned code without anything else being typed into that field', async () => {
    const element = await form(database.repositories, scanningSource(PAYLOAD))
    await waitUntil(() => element.querySelector('[data-scan]') !== null)
    ;(element.querySelector('[data-scan]') as HTMLElement).click()
    await waitUntil(() => fieldValue(element, 'credential') === PAYLOAD)

    fill(element, 'name', 'Kitchen ceiling light')
    typeRoom(element, 'Ground Floor/Kitchen')
    await submit(element, async () => (await devices()).length === 1)

    const [device] = await devices()
    expect(device?.payload).toBe(PAYLOAD)
    expect(device?.vendorId).toBe(0xfff1)
  })
})

describe('looking up the manufacturer', () => {
  it('shows a quiet hint while it asks, then the names', async () => {
    const answer = deferred<LookupOutcome>()
    const { api, calls } = fakeCatalog(() => answer.promise)
    const element = await form(database.repositories, neverAvailable(), { api })

    typeCode(element, aqaraPayload())
    await waitUntil(() => element.querySelector('[data-catalog-pending]') !== null, 'no hint')
    expect(element.querySelector('[data-catalog-status]')?.getAttribute('role')).toBe('status')
    expect(calls[0]?.code).toBe(aqaraPayload())

    answer.resolve({ kind: 'found', lookup: AQARA_LOOKUP })
    await waitUntil(() => element.querySelector('[data-catalog]') !== null, 'no names')
    expect(element.querySelector('[data-catalog-pending]')).toBeNull()
    // The preferred name, not the vendor name: what people call the company.
    expect(element.querySelector('[data-catalog-manufacturer]')?.textContent).toBe('Aqara Home')
    expect(element.querySelector('[data-catalog-product]')?.textContent).toBe(
      'Aqara Door and Window Sensor P2',
    )
  })

  it('waits for typing to pause before asking', async () => {
    const { api, calls } = fakeCatalog(found)
    const element = await form(database.repositories, neverAvailable(), { api })

    typeCode(element, aqaraPayload())
    await new Promise((resolve) => setTimeout(resolve, 100))
    expect(calls).toHaveLength(0)
    await waitUntil(() => calls.length === 1, 'never asked', { timeout: 1000 })
  })

  it('asks exactly 300 ms after typing stops', async () => {
    const { api, calls } = fakeCatalog(found)
    const element = await form(database.repositories, neverAvailable(), { api })
    await element.updateComplete

    // Faked only around the typing: the form's own setup above needs real timers.
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    try {
      typeCode(element, aqaraPayload())
      vi.advanceTimersByTime(299)
      expect(calls).toHaveLength(0)
      vi.advanceTimersByTime(1)
      expect(calls).toHaveLength(1)
    } finally {
      vi.useRealTimers()
    }
  })

  it('restarts the wait on every keystroke, so a burst of typing asks once', async () => {
    const { api, calls } = fakeCatalog(found)
    const element = await form(database.repositories, neverAvailable(), { api })
    await element.updateComplete

    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    try {
      typeCode(element, aqaraPayload())
      vi.advanceTimersByTime(200)
      typeCode(element, aqaraPayload())
      vi.advanceTimersByTime(200)
      // 400 ms in, and the first timer would have fired at 300: it was cancelled.
      expect(calls).toHaveLength(0)
      vi.advanceTimersByTime(100)
      expect(calls).toHaveLength(1)
    } finally {
      vi.useRealTimers()
    }
  })

  it('asks nothing while signed out, and saves without names', async () => {
    const { api, calls } = fakeCatalog(found)
    const element = await form(database.repositories, neverAvailable(), { api })
    element.signedIn = () => false
    typeCode(element, aqaraPayload())
    fill(element, 'name', 'Front door sensor')
    typeRoom(element, 'Hall')
    await new Promise((resolve) => setTimeout(resolve, 400))

    await submit(element, async () => (await devices()).length === 1)

    expect(calls).toHaveLength(0)
    expect(element.querySelector('[data-catalog-pending]')).toBeNull()
    expect((await devices())[0]).not.toHaveProperty('vendorName')
  })

  it('looks up a code that arrives from a picture', async () => {
    const { api, calls } = fakeCatalog(found)
    const element = await form(database.repositories, neverAvailable(), { api })
    element.decodeImage = async () => [aqaraPayload()]
    await element.updateComplete

    await chooseFile(element, pngFile())

    await waitUntil(() => calls.length === 1, 'a code from a picture was never looked up')
    expect(calls[0]?.code).toBe(aqaraPayload())
  })

  it('asks nothing when the form closes during the wait', async () => {
    const { api, calls } = fakeCatalog(found)
    const element = await form(database.repositories, neverAvailable(), { api })
    typeCode(element, aqaraPayload())

    element.remove()
    await new Promise((resolve) => setTimeout(resolve, 400))

    expect(calls).toHaveLength(0)
  })

  it('forgets a lookup in flight when the form closes, so it asks again when it returns', async () => {
    const { api, calls } = fakeCatalog(() => new Promise<LookupOutcome>(() => {}))
    const element = await form(database.repositories, neverAvailable(), { api })
    typeCode(element, aqaraPayload())
    await waitUntil(() => calls.length === 1, 'never asked')
    await waitUntil(() => element.querySelector('[data-catalog-pending]') !== null, 'no hint')

    // Moved rather than destroyed: a router or a drag can detach and re-attach the same element.
    element.remove()
    document.body.append(element)
    await element.updateComplete
    // The aborted question is not still "pending" on screen...
    expect(element.querySelector('[data-catalog-pending]')).toBeNull()

    // ...and the same code is a new question, not one the form believes it is already asking.
    typeCode(element, aqaraPayload())
    await waitUntil(() => calls.length === 2, 'the code was never asked again')
    element.remove()
  })

  it('copies the answer into the saved device', async () => {
    const { api } = fakeCatalog(found)
    const element = await form(database.repositories, neverAvailable(), { api })
    typeCode(element, aqaraPayload())
    await waitUntil(() => element.querySelector('[data-catalog]') !== null, 'no names')

    fill(element, 'name', 'Front door sensor')
    typeRoom(element, 'Hall')
    await submit(element, async () => (await devices()).length === 1)

    const [device] = await devices()
    expect(device?.vendorName).toBe('Aqara')
    expect(device?.vendorPreferredName).toBe('Aqara Home')
    expect(device?.partNumber).toBe('AS056')
    expect(device?.catalogSource).toBe('found')
    expect(device?.payloadVersion).toBe(0)
    expect(device?.discovery).toEqual({ softAp: false, ble: true, onNetwork: false })
  })

  it('asks nothing while the browser is offline, and saves without names', async () => {
    const { api, calls } = fakeCatalog(found)
    const element = await form(database.repositories, neverAvailable(), { api, online: false })
    typeCode(element, aqaraPayload())
    fill(element, 'name', 'Front door sensor')
    typeRoom(element, 'Hall')
    await new Promise((resolve) => setTimeout(resolve, 400))

    await submit(element, async () => (await devices()).length === 1)

    expect(calls).toHaveLength(0)
    const [device] = await devices()
    expect(device).not.toHaveProperty('vendorName')
    expect(device).not.toHaveProperty('catalogCheckedAt')
  })

  it('shows nothing alarming when the lookup fails, and saves without names', async () => {
    const { api, calls } = fakeCatalog(() => Promise.resolve({ kind: 'unavailable' }))
    const element = await form(database.repositories, neverAvailable(), { api })
    typeCode(element, aqaraPayload())
    await waitUntil(() => calls.length === 1, 'never asked')
    // The hint must go once the failure is in: a state stuck at pending would leave
    // "Looking up manufacturer…" on screen for good.
    await waitUntil(
      () => element.querySelector('[data-catalog-pending]') === null,
      'the hint never went away',
    )
    await element.updateComplete

    expect(calls).toHaveLength(1)
    expect(element.querySelector('[data-catalog]')).toBeNull()
    expect(element.querySelector('wa-callout')).toBeNull()
    expect(element.querySelector('[data-error]')).toBeNull()

    fill(element, 'name', 'Front door sensor')
    typeRoom(element, 'Hall')
    await submit(element, async () => (await devices()).length === 1)

    const [device] = await devices()
    expect(device).not.toHaveProperty('vendorName')
    expect(device).not.toHaveProperty('catalogCheckedAt')
  })

  it('aborts the earlier lookup when the code changes', async () => {
    const { api, calls } = fakeCatalog(() => new Promise<LookupOutcome>(() => {}))
    const element = await form(database.repositories, neverAvailable(), { api })

    typeCode(element, aqaraPayload())
    await waitUntil(() => calls.length === 1, 'never asked')
    typeCode(element, '749701123365521327687')

    expect(calls[0]?.signal?.aborted).toBe(true)
    // A 21-digit code carries the ids, so it is looked up too, by its digits.
    await waitUntil(() => calls.length === 2, 'the new code was never asked')
    expect(calls[1]?.code).toBe('749701123365521327687')
  })

  it('never asks about an 11-digit code, which carries no ids', async () => {
    const { api, calls } = fakeCatalog(found)
    const element = await form(database.repositories, neverAvailable(), { api })
    typeCode(element, SHORT_CODE)
    await new Promise((resolve) => setTimeout(resolve, 400))
    expect(calls).toHaveLength(0)
  })

  it('aborts the lookup when the form closes', async () => {
    const { api, calls } = fakeCatalog(() => new Promise<LookupOutcome>(() => {}))
    const element = await form(database.repositories, neverAvailable(), { api })
    typeCode(element, aqaraPayload())
    await waitUntil(() => calls.length === 1, 'never asked')

    element.remove()

    expect(calls[0]?.signal?.aborted).toBe(true)
  })

  it('does not wait for a slow lookup before saving, and ignores it when it lands', async () => {
    const answer = deferred<LookupOutcome>()
    const { api, calls } = fakeCatalog(() => answer.promise)
    const element = await form(database.repositories, neverAvailable(), { api })
    typeCode(element, aqaraPayload())
    await waitUntil(() => calls.length === 1, 'never asked')

    fill(element, 'name', 'Front door sensor')
    typeRoom(element, 'Hall')
    await submit(element, async () => (await devices()).length === 1)
    answer.resolve({ kind: 'found', lookup: AQARA_LOOKUP })
    await new Promise((resolve) => setTimeout(resolve, 50))

    const all = await devices()
    expect(all).toHaveLength(1)
    expect(all[0]).not.toHaveProperty('vendorName')
  })

  it('drops the names when the code is edited after they arrived', async () => {
    const { api } = fakeCatalog(found)
    const element = await form(database.repositories, neverAvailable(), { api })
    typeCode(element, aqaraPayload())
    await waitUntil(() => element.querySelector('[data-catalog]') !== null, 'no names')

    typeCode(element, SHORT_CODE)
    await element.updateComplete
    expect(element.querySelector('[data-catalog]')).toBeNull()

    fill(element, 'name', 'Hall sensor')
    typeRoom(element, 'Hall')
    await submit(element, async () => (await devices()).length === 1)
    expect((await devices())[0]).not.toHaveProperty('vendorName')
  })

  it('looks up a code that arrives from the camera', async () => {
    const { api, calls } = fakeCatalog(found)
    const element = await form(database.repositories, scanningSource(aqaraPayload()), { api })
    await waitUntil(() => element.querySelector('[data-scan]') !== null)
    ;(element.querySelector('[data-scan]') as HTMLElement).click()
    await waitUntil(() => calls.length === 1, 'a scanned code was never looked up')
  })
})

/**
 * #238: a device saved before its lookup answered gets its names "as soon as the app is next
 * online" (PRODUCT.md). When it is online and signed in already, that is now: the form asks the
 * shell for a backfill run instead of leaving it to the next sign-in, reconnect or switch.
 */
describe('asking for backfill after a save', () => {
  /** Counts the requests for a backfill run that reach `window`. */
  function listen() {
    const heard: Event[] = []
    const record = (event: Event) => heard.push(event)
    window.addEventListener(BACKFILL_WANTED, record)
    return { heard, done: () => window.removeEventListener(BACKFILL_WANTED, record) }
  }

  async function save(element: AddDeviceView, code: string): Promise<void> {
    typeCode(element, code)
    fill(element, 'name', 'Front door sensor')
    typeRoom(element, 'Hall')
    await submit(element, async () => (await devices()).length === 1)
  }

  it('asks once when the device was saved without an answer, online and signed in', async () => {
    const { api } = fakeCatalog(() => new Promise<LookupOutcome>(() => {}))
    const element = await form(database.repositories, neverAvailable(), { api })
    const { heard, done } = listen()
    try {
      await save(element, aqaraPayload())
      expect(heard).toHaveLength(1)
    } finally {
      done()
    }
  })

  it('does not ask when the answer was saved with the device', async () => {
    const { api } = fakeCatalog(found)
    const element = await form(database.repositories, neverAvailable(), { api })
    const { heard, done } = listen()
    try {
      typeCode(element, aqaraPayload())
      await waitUntil(() => element.querySelector('[data-catalog]') !== null, 'no names')
      await save(element, aqaraPayload())
      expect(heard).toHaveLength(0)
    } finally {
      done()
    }
  })

  const cases: ReadonlyArray<
    readonly [string, { readonly online?: boolean } | undefined, () => string]
  > = [
    ['offline', { online: false }, () => aqaraPayload()],
    ['signed out', undefined, () => aqaraPayload()],
    ['an 11-digit code, which has nothing to look up', {}, () => SHORT_CODE],
  ]
  it.each(cases)('does not ask when %s', async (_case, catalog, code) => {
    const { api } = fakeCatalog(() => new Promise<LookupOutcome>(() => {}))
    const element = await form(
      database.repositories,
      neverAvailable(),
      catalog === undefined ? undefined : { api, ...catalog },
    )
    const { heard, done } = listen()
    try {
      await save(element, code())
      expect(heard).toHaveLength(0)
    } finally {
      done()
    }
  })
})
