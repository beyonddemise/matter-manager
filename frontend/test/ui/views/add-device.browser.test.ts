import '@awesome.me/webawesome-pro/dist/components/button/button.js'
import '@awesome.me/webawesome-pro/dist/components/callout/callout.js'
import '@awesome.me/webawesome-pro/dist/components/combobox/combobox.js'
import '@awesome.me/webawesome-pro/dist/components/icon/icon.js'
import '@awesome.me/webawesome-pro/dist/components/dialog/dialog.js'
import '@awesome.me/webawesome-pro/dist/components/input/input.js'
import '@awesome.me/webawesome-pro/dist/components/option/option.js'
import { fixture, html, waitUntil } from '@open-wc/testing-helpers'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { userEvent } from 'vitest/browser'
import type { ProjectRepositories } from '../../../src/data/index.js'
import type { DeviceDocument, Unsaved } from '../../../src/domain/index.js'
import { BACKFILL_WANTED, type CatalogApi, type LookupOutcome } from '../../../src/ui/catalog.js'
import { PROJECT_CHANGED, PROJECT_DATA_CHANGED } from '../../../src/ui/current-project.js'
import { activateLocale } from '../../../src/ui/i18n/localization.js'
import { ImageScanError } from '../../../src/ui/scan/image.js'
import type { ScanSource } from '../../../src/ui/scan/source.js'
import type { AddDeviceView } from '../../../src/ui/views/add-device.js'
import '../../../src/ui/views/add-device.js'
import '../../../src/ui/views/scan-dialog.js'
import { browserDatabase, type TestDatabase } from '../support/browser-database.js'
import { AQARA_LOOKUP, aqaraPayload, deferred, fakeCatalog } from '../support/catalog.js'
import { lockedDatabase } from '../support/locked-database.js'

/** The verified reference device; see `test/domain/matter/payload.test.ts`. */
const PAYLOAD = 'MT:Y.K9042C00KA0648G00'
const SHORT_CODE = '34970112332'
/** The form's own address; each step after the first adds `?step=` to it (#356). */
const FORM = '#/devices/new'

let database: TestDatabase

beforeEach(() => {
  database = browserDatabase()
  // An entry no earlier test's form stamped, at the form's address, so that each test's form
  // starts its history afresh rather than adopting entries another form left (#356).
  history.replaceState(null, '', FORM)
})

afterEach(async () => {
  // A form still walking its history back (after a save) would otherwise do so in the next test.
  for (const element of document.querySelectorAll<AddDeviceView>('add-device-view')) {
    await waitUntil(() => element.historySettled, 'a form never settled its history')
  }
  await database.destroy()
})

/**
 * Builds the form with a database of its own.
 *
 * Deliberately does not wait for the room list. Submitting re-reads the rooms, so a test does
 * not have to synchronise with a read it cannot see — and the test below that submits with no
 * wait at all is the one pinning that.
 */
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

/**
 * Builds the form with a camera check that gives up after 50 ms rather than the real wait, so
 * a test of the timeout does not sit through it. Bound in the template because the check
 * starts in `firstUpdated`: assigning after `fixture` returns would be too late.
 */
async function formTimingOut(scanSource: ScanSource): Promise<AddDeviceView> {
  await customElements.whenDefined('wa-input')
  return (await fixture(
    html`<add-device-view
      .repositories=${database.repositories}
      .scanSource=${scanSource}
      .scanCheckTimeoutMs=${50}
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
  await waitUntil(() => formUpload(element) !== null, 'no upload control on the form')
  const input = element.querySelector('[data-upload-input]') as HTMLInputElement
  const transfer = new DataTransfer()
  transfer.items.add(file)
  input.files = transfer.files
  input.dispatchEvent(new Event('change', { bubbles: true }))
}

/**
 * The form's own upload control, not the scan dialog's: the dialog renders into the light DOM
 * too, and its footer has a `[data-upload]` of its own that is always in the tree.
 */
function formUpload(element: HTMLElement): Element | null {
  return element.querySelector('[data-step-panel="scan"] [data-upload]')
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
  const control = element.querySelector(`[data-field="${field}"]`) as {
    value?: unknown
    inputValue?: unknown
  } | null
  // The room is its text, as the form reads it (`roomValue`): the combobox's `value` lags the
  // text, and keeps a typed room the text no longer shows.
  const shown = field === 'room' ? control?.inputValue : control?.value
  return typeof shown === 'string' ? shown : ''
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

/** The form's stepper. */
function stepper(element: HTMLElement): HTMLElement & {
  active: string
  orientation: string
  updateComplete: Promise<unknown>
} {
  const found = element.querySelector('wa-stepper')
  if (found === null) throw new Error('no stepper')
  return found as never
}

/** The step the stepper has on screen, by name. */
function activeStep(element: HTMLElement): string {
  return stepper(element).active
}

/**
 * Lets a step change finish: the stepper renders first and only then says `wa-step-change`,
 * which is what the view mirrors into its panels.
 */
async function settle(element: AddDeviceView): Promise<void> {
  await element.updateComplete
  await stepper(element).updateComplete
  await element.updateComplete
}

/** Presses Next, the way a person does. */
async function next(element: AddDeviceView): Promise<void> {
  const button = element.querySelector('[data-next]') as HTMLElement | null
  if (button === null) throw new Error('no Next button on this step')
  button.click()
  await settle(element)
}

/**
 * Dispatches `submit` on the form: what Next and Save end in, without the click.
 *
 * Not a stand-in for Enter in a field. `wa-input` handles that key itself, by clicking the
 * form's first submit button, so a real keypress is tested with `userEvent` instead - a
 * dispatched `submit` would pass even if that button were missing.
 */
function dispatchSubmit(element: HTMLElement): void {
  element
    .querySelector('form')
    ?.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }))
}

/**
 * Submits the form and waits for whatever the caller says settles it.
 *
 * The form is four steps, and `submit` on steps 1-3 means Next. So this walks forward, one
 * submit per step, until it reaches Review or a step refuses (an error on screen is the
 * refusal a test is usually waiting for), and only on Review submits once more to save. Every
 * test written against the one-page form keeps calling this unchanged.
 */
async function submit(element: AddDeviceView, settled: () => boolean | Promise<boolean>) {
  for (
    let steps = 0;
    steps < 4 && activeStep(element) !== 'review' && element.querySelector('[data-error]') === null;
    steps++
  ) {
    dispatchSubmit(element)
    await settle(element)
  }
  if (activeStep(element) === 'review') dispatchSubmit(element)
  await waitUntil(settled, 'the form never settled after submit', { timeout: 3000 })
}

const devices = (): Promise<DeviceDocument[]> => database.repositories.devices.list()
/** Each stored device's room, in id order: where the form filed what it saved. */
const filed = async (): Promise<string[]> =>
  (await devices()).sort((a, b) => a._id.localeCompare(b._id)).map((device) => device.room)

/**
 * A device already filed under `room`: how a room exists (ADR 0021). Its id sorts before any
 * the form generates, so {@link filed} lists it first.
 */
async function existing(room: string, id = 'device:0-existing'): Promise<void> {
  const device: Unsaved<DeviceDocument> = {
    _id: id,
    type: 'device',
    name: 'Already here',
    room,
    manualCode: SHORT_CODE,
    installedAt: '2026-09-02',
    addedAt: '2026-09-02T09:00:00.000Z',
    disabled: false,
    remarks: [],
  }
  await database.repositories.devices.save(device)
}

describe('when the existing rooms cannot be read', () => {
  it('says so, and still lets a device be entered', async () => {
    // Not fatal: a room can be typed. But offering no suggestions in silence invites somebody
    // to type "Kitchen" for a project that already has one, and the duplicate outlives the
    // failure that caused it.
    // The rooms are read from the devices, so a failing device list is how they fail.
    const failing = {
      devices: {
        list: async () => Promise.reject(new Error('indexed_db_went_bad')),
        get: async () => undefined,
        save: async () => undefined,
      },
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
  it('files the device under the path typed', async () => {
    const element = await form()
    fill(element, 'credential', PAYLOAD)
    fill(element, 'name', 'Kitchen ceiling light')
    typeRoom(element, 'Ground Floor/Kitchen')

    await submit(element, async () => (await devices()).length === 1)

    expect(await filed()).toEqual(['Ground Floor/Kitchen'])
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

    expect(await filed()).toEqual(['First Floor/Bathroom'])
  })

  it('offers the rooms the other devices are in', async () => {
    await existing('Ground Floor/Kitchen')
    await existing('ground floor/kitchen', 'device:0-second')
    await existing('Attic', 'device:0-third')

    const element = await form()
    await waitUntil(() => element.rooms.length === 2, 'the view never read the existing rooms')
    await element.updateComplete

    // One option per room, however many ways its devices spell it.
    const options = [...element.querySelectorAll('[data-field="room"] wa-option')].map((option) =>
      option.getAttribute('value'),
    )
    expect(options).toHaveLength(2)
    expect(options).toContain('Attic')
  })

  it('takes a room picked from the list', async () => {
    await existing('Ground Floor/Kitchen')

    const element = await form()
    await waitUntil(() => element.rooms.length === 1, 'the view never read the existing room')
    await element.updateComplete

    // The other half of the control: `value` is what selecting an option leaves behind, and
    // it only sticks because the option is there to select.
    const combobox = element.querySelector('[data-field="room"]') as { value?: string }
    combobox.value = 'Ground Floor/Kitchen'

    fill(element, 'credential', PAYLOAD)
    fill(element, 'name', 'Kitchen ceiling light')
    await submit(element, async () => (await devices()).length === 2)

    expect(await filed()).toEqual(['Ground Floor/Kitchen', 'Ground Floor/Kitchen'])
  })

  it('reuses an existing spelling even when submitted before the first read lands', async () => {
    // The race CodeRabbit found on #74. `firstUpdated` starts the room read asynchronously; a
    // user who types an existing room in other capitals and saves before it arrives would, if
    // the form planned against the rooms it was holding, store a *second* spelling of the room,
    // visible only on a slow device where nobody is watching. Submitting with no wait at all is
    // what pins the re-read.
    await existing('Ground Floor/Kitchen')

    const element = await form()
    expect(element.rooms).toHaveLength(0)

    fill(element, 'credential', PAYLOAD)
    fill(element, 'name', 'Kitchen ceiling light')
    typeRoom(element, 'ground floor/kitchen')
    await submit(element, async () => (await devices()).length === 2)

    expect(await filed()).toEqual(['Ground Floor/Kitchen', 'Ground Floor/Kitchen'])
  })

  it('reuses an existing spelling rather than storing a second one', async () => {
    await existing('Ground Floor/Kitchen')

    const element = await form()
    await waitUntil(() => element.rooms.length === 1, 'the view never read the existing room')

    fill(element, 'credential', PAYLOAD)
    fill(element, 'name', 'Kitchen ceiling light')
    // Typed differently on purpose: the same room to a person reading it, and `roomPathKey`
    // is what has to agree.
    typeRoom(element, 'ground floor / KITCHEN')

    await submit(element, async () => (await devices()).length === 2)

    expect(await filed()).toEqual(['Ground Floor/Kitchen', 'Ground Floor/Kitchen'])
  })

  it('follows a change of mind after a room was already picked', async () => {
    // Picking an option syncs the combobox's `inputValue` to that option's label, but typing
    // afterwards leaves `value` on the old selection. Reading `value` whenever it is set — as
    // this form used to — files the device in the room the user just changed their mind about,
    // and nothing on screen says so.
    await existing('Ground Floor/Kitchen')
    await existing('Ground Floor/Hall', 'device:0-hall')

    const element = await form()
    await waitUntil(() => element.rooms.length === 2, 'the view never read the existing rooms')

    fill(element, 'credential', PAYLOAD)
    fill(element, 'name', 'Hall sensor')
    // On Place it with the combobox not focused, so the state pinned here is the one before any
    // blur: a stale selection and different typed text, read as the text. The real-keyboard
    // test below covers leaving the field, which `allow-custom-value` keeps from restoring the
    // pick (#355).
    await next(element)
    ;(document.activeElement as HTMLElement | null)?.blur()
    selectRoom(element, 'Ground Floor/Kitchen')
    await element.updateComplete
    typeRoom(element, 'Ground Floor/Hall')

    await submit(element, async () => (await devices()).length === 3)

    const saved = (await devices()).find((device) => device.name === 'Hall sensor')
    expect(saved?.room).toBe('Ground Floor/Hall')
  })

  it('keeps a room typed after a pick when the field is left, on a real keyboard (#355)', async () => {
    // The order a person actually uses: pick from the list, think again, type over it, and
    // Tab away. A single-select combobox that only accepts options puts the old pick back on
    // blur, so the typed room was gone before Save could read it.
    await existing('Kitchen')
    const element = await form()
    await waitUntil(() => element.rooms.length === 1, 'the view never read the existing rooms')
    fill(element, 'credential', PAYLOAD)
    fill(element, 'name', 'Attic sensor')
    await next(element)

    const combobox = element.querySelector('[data-field="room"]') as HTMLElement & {
      value?: unknown
      inputValue?: unknown
    }
    combobox.focus()
    await userEvent.keyboard('Kitch')
    const kitchen = combobox.querySelector('wa-option[value="Kitchen"]') as HTMLElement
    await userEvent.click(kitchen)
    await waitUntil(() => combobox.value === 'Kitchen', 'the pick never landed')
    await userEvent.keyboard('{Tab}')

    // Focusing the field selects its text, so typing replaces the pick.
    combobox.focus()
    await userEvent.keyboard('Attic')
    await userEvent.keyboard('{Tab}')
    await element.updateComplete
    expect(combobox.inputValue).toBe('Attic')

    await submit(element, async () => (await devices()).length === 2)

    const saved = (await devices()).find((device) => device.name === 'Attic sensor')
    expect(saved?.room).toBe('Attic')
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

    // Save lives on Review only, so the steps are walked with Next first.
    await next(element)
    await next(element)
    await next(element)
    const save = element.querySelector('[data-save]') as HTMLElement
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

/** The panel a control sits in, by its `data-step-panel`. */
function panelOf(element: HTMLElement, field: string): string | null | undefined {
  return element
    .querySelector(`[data-field="${field}"]`)
    ?.closest('[data-step-panel]')
    ?.getAttribute('data-step-panel')
}

/** Whether a step carries the checkmark that unlocks the steps after it. */
function completed(element: HTMLElement, step: string): boolean {
  return element.querySelector(`wa-step[name="${step}"]`)?.hasAttribute('completed') ?? false
}

/** Whether the stepper marks a step as failing its check: a warning in its marker. */
function flagged(element: HTMLElement, step: string): boolean {
  const found = element.querySelector(`wa-step[name="${step}"]`)
  return (
    found?.getAttribute('variant') === 'danger' &&
    found.querySelector('[data-step-problem]') !== null
  )
}

/** What a control's hint says now: its own help, or the message about it. */
function hintOf(element: HTMLElement, field: string): string | undefined {
  return (element.querySelector(`[data-field="${field}"]`) as { hint?: string } | null)?.hint
}

/** The message in the error callout, as the hint beside the control would repeat it. */
function errorText(element: HTMLElement): string | undefined {
  return element.querySelector('[data-error]')?.textContent?.trim()
}

/** Whether something is actually on screen, not merely in the tree. */
function visible(element: HTMLElement, selector: string): boolean {
  return element.querySelector(selector)?.checkVisibility() ?? false
}

/** Presses Next until Review, from a form whose every field is valid. */
async function toReview(element: AddDeviceView): Promise<void> {
  await next(element)
  await next(element)
  await next(element)
  expect(activeStep(element)).toBe('review')
}

/** Fills every field validly, so that each step's Next is accepted. */
function fillAll(element: HTMLElement): void {
  fill(element, 'credential', PAYLOAD)
  fill(element, 'serial', 'SN-000123')
  fill(element, 'installed-at', '2026-08-19')
  typeRoom(element, 'Ground Floor/Kitchen')
  fill(element, 'spot', 'ceiling, north end')
  fill(element, 'name', 'Kitchen ceiling light')
}

describe('the steps', () => {
  it('shows Scan, Place, Name and Save, starting on Scan', async () => {
    const element = await form()
    await settle(element)

    const labels = [...element.querySelectorAll('wa-step')].map((step) => step.textContent?.trim())
    expect(labels).toEqual(['Scan', 'Place', 'Name', 'Save'])
    expect(activeStep(element)).toBe('scan')
    expect(visible(element, '[data-step-panel="scan"]')).toBe(true)
    for (const step of ['place', 'name', 'review']) {
      expect(visible(element, `[data-step-panel="${step}"]`), step).toBe(false)
    }
  })
  it('offers Next and Cancel on Scan it, and no Back', async () => {
    const element = await form()
    await settle(element)

    expect(element.querySelector('[data-back]')).toBeNull()
    expect(element.querySelector('[data-next]')).not.toBeNull()
    expect(element.querySelector('[data-save]')).toBeNull()
    expect(element.querySelector('wa-button[href="#/devices"]')).not.toBeNull()
  })

  it('offers Back, Save and Cancel on Review, and no Next', async () => {
    const element = await form()
    fillAll(element)
    await toReview(element)

    expect(visible(element, '[data-step-panel="review"]')).toBe(true)
    expect(element.querySelector('[data-back]')).not.toBeNull()
    expect(element.querySelector('[data-next]')).toBeNull()
    expect(element.querySelector('[data-save]')).not.toBeNull()
    expect(element.querySelector('wa-button[href="#/devices"]')).not.toBeNull()
  })

  it('puts each control on its step', async () => {
    const element = await form()

    expect(panelOf(element, 'credential')).toBe('scan')
    expect(panelOf(element, 'serial')).toBe('scan')
    expect(panelOf(element, 'installed-at')).toBe('scan')
    expect(panelOf(element, 'room')).toBe('place')
    expect(panelOf(element, 'spot')).toBe('place')
    expect(panelOf(element, 'name')).toBe('name')
  })

  it('moves on from Scan with an empty setup code, flags it, and says why on return', async () => {
    // Validation without a gate: the step is checked as it is left, but never holds the
    // person on it. The message waits for their return - shown on Place, it would name a
    // control that is not on screen.
    const element = await form()

    await next(element)

    expect(activeStep(element)).toBe('place')
    expect(flagged(element, 'scan')).toBe(true)
    expect(completed(element, 'scan')).toBe(false)
    expect(element.querySelector('[data-error]')).toBeNull()

    ;(element.querySelector('[data-back]') as HTMLElement).click()
    await settle(element)

    expect(activeStep(element)).toBe('scan')
    expect(errorText(element)).toBeTruthy()
    expect(hintOf(element, 'credential')).toBe(errorText(element))
  })
  it('moves on from Place without a room, and flags it', async () => {
    const element = await form()
    fill(element, 'credential', PAYLOAD)
    await next(element)
    expect(activeStep(element)).toBe('place')

    await next(element)

    expect(activeStep(element)).toBe('name')
    expect(flagged(element, 'place')).toBe(true)
    expect(completed(element, 'scan')).toBe(true)
  })
  it('moves on from Name without a name, and its Save card says why', async () => {
    const element = await form()
    fill(element, 'credential', PAYLOAD)
    typeRoom(element, 'Kitchen')
    await next(element)
    await next(element)
    expect(activeStep(element)).toBe('name')

    await next(element)

    expect(activeStep(element)).toBe('review')
    expect(flagged(element, 'name')).toBe(true)
    expect(reviewOf(element, 'name').dataset.status).toBe('problem')
    expect(
      reviewOf(element, 'name').querySelector('[data-review-problem]')?.textContent?.trim(),
    ).toBeTruthy()
    expect(reviewOf(element, 'scan').dataset.status).toBe('complete')
    expect(reviewOf(element, 'place').dataset.status).toBe('complete')
  })
  it('keeps every value across Back and Next', async () => {
    const element = await form()
    fillAll(element)
    const fields = ['credential', 'serial', 'installed-at', 'room', 'spot', 'name']
    const before = fields.map((field) => fieldValue(element, field))
    await next(element)
    await next(element)
    await next(element)
    expect(activeStep(element)).toBe('review')

    for (const _ of [1, 2]) {
      ;(element.querySelector('[data-back]') as HTMLElement).click()
      await settle(element)
    }
    expect(activeStep(element)).toBe('place')
    await next(element)
    await next(element)

    expect(activeStep(element)).toBe('review')
    expect(fields.map((field) => fieldValue(element, field))).toEqual(before)
  })

  it('takes the flag away once the step is fixed and left again', async () => {
    const element = await form()
    await next(element)
    expect(flagged(element, 'scan')).toBe(true)

    ;(element.querySelector('[data-back]') as HTMLElement).click()
    await settle(element)
    fill(element, 'credential', PAYLOAD)
    await next(element)

    expect(flagged(element, 'scan')).toBe(false)
    expect(completed(element, 'scan')).toBe(true)
  })
  it('keeps every checkmark when going back', async () => {
    // Clearing them would lock every later step and make Review's "Edit" a walk through all of
    // them again.
    const element = await form()
    fillAll(element)
    await toReview(element)

    ;(element.querySelector('[data-back]') as HTMLElement).click()
    await settle(element)

    expect(activeStep(element)).toBe('name')
    expect(completed(element, 'scan')).toBe(true)
    expect(completed(element, 'place')).toBe(true)
    expect(completed(element, 'name')).toBe(true)
  })

  it('allows a jump forward from a step that still passes', async () => {
    const element = await form()
    fillAll(element)
    await toReview(element)

    element.goToStep('scan')
    await settle(element)
    expect(activeStep(element)).toBe('scan')
    ;(element.querySelector('wa-step[name="review"]') as HTMLElement).click()
    await settle(element)

    expect(activeStep(element)).toBe('review')
    expect(visible(element, '[data-step-panel="review"]')).toBe(true)
  })

  it('jumps forward from a step made invalid, and flags it on Save', async () => {
    const element = await form()
    fillAll(element)
    await toReview(element)

    element.goToStep('scan')
    await settle(element)
    fill(element, 'credential', '')
    ;(element.querySelector('wa-step[name="review"]') as HTMLElement).click()
    await settle(element)

    expect(activeStep(element)).toBe('review')
    expect(flagged(element, 'scan')).toBe(true)
    expect(reviewOf(element, 'scan').dataset.status).toBe('problem')
  })
  it('flags a step jumped over that was emptied since it was passed', async () => {
    // Arriving on Save checks every step, not only the one left, so a step emptied after an
    // Edit and then jumped over cannot keep the checkmark it earned earlier.
    const element = await form()
    fillAll(element)
    await toReview(element)

    await edit(element, 'place')
    typeRoom(element, '')
    ;(element.querySelector('[data-back]') as HTMLElement).click()
    await settle(element)
    expect(activeStep(element)).toBe('scan')
    ;(element.querySelector('wa-step[name="review"]') as HTMLElement).click()
    await settle(element)

    expect(activeStep(element)).toBe('review')
    expect(flagged(element, 'place')).toBe(true)
    expect(reviewOf(element, 'place').dataset.status).toBe('problem')
    expect(await devices()).toHaveLength(0)
  })
  it('advances on a real Enter in the setup-code field', async () => {
    // A pressed key, not a dispatched `submit`: `wa-input` turns Enter into a click on the
    // form's first submit button, so this only works if Next is one.
    const element = await form()
    fillAll(element)
    ;(element.querySelector('[data-field="credential"]') as HTMLElement).focus()

    await userEvent.keyboard('{Enter}')
    await waitUntil(() => activeStep(element) === 'place', 'Enter never advanced to Place it')

    expect(await devices()).toHaveLength(0)
  })

  it('advances on a real Enter in the name field, to Review and not to a save', async () => {
    const element = await form()
    fillAll(element)
    await next(element)
    await next(element)
    expect(activeStep(element)).toBe('name')
    ;(element.querySelector('[data-field="name"]') as HTMLElement).focus()

    await userEvent.keyboard('{Enter}')
    await waitUntil(() => activeStep(element) === 'review', 'Enter never advanced to Review')
    await settle(element)

    expect(await devices()).toHaveLength(0)
  })

  it('saves on Review only from Save, which Enter on the button presses', async () => {
    const element = await form()
    fillAll(element)
    await toReview(element)
    await element.updateComplete

    // Focus starts on Review's heading, which is no control: Enter there does nothing.
    await userEvent.keyboard('{Enter}')
    await settle(element)
    expect(activeStep(element)).toBe('review')
    expect(await devices()).toHaveLength(0)

    ;(element.querySelector('[data-save]') as HTMLElement).focus()
    await userEvent.keyboard('{Enter}')
    await waitUntil(async () => (await devices()).length === 1, 'Save never saved')
  })

  it('advances on Enter rather than saving', async () => {
    const element = await form()
    fillAll(element)
    await next(element)
    expect(activeStep(element)).toBe('place')

    dispatchSubmit(element)
    await settle(element)

    expect(activeStep(element)).toBe('name')
    expect(await devices()).toHaveLength(0)
  })

  it('picks a room on Enter in the room field, and never leaves Place it', async () => {
    // Observed against the real component, not assumed: `wa-combobox` takes every Enter for
    // itself (preventDefault and stopPropagation in its keydown handler). The first one picks
    // the highlighted "Create" option, and a second one, with the list closed, opens the list
    // again. Neither reaches the form, so neither advances the step, and nothing is saved:
    // Enter in the room field never skips Place it.
    const element = await form()
    fill(element, 'credential', PAYLOAD)
    await next(element)
    expect(activeStep(element)).toBe('place')

    const combobox = element.querySelector('[data-field="room"]') as HTMLElement & {
      value?: unknown
    }
    combobox.focus()
    await userEvent.keyboard('Attic')
    await waitUntil(
      () => combobox.querySelector('wa-option[data-create-option]:not([hidden])') !== null,
      'the combobox never offered to create the room',
    )
    await userEvent.keyboard('{Enter}')
    await waitUntil(() => combobox.value === 'Attic', 'Enter never created the room')
    await settle(element)
    expect(activeStep(element)).toBe('place')

    await userEvent.keyboard('{Enter}')
    await settle(element)
    expect(activeStep(element)).toBe('place')
    expect(await devices()).toHaveLength(0)
  })

  it('moves focus into the new step', async () => {
    // WCAG 2.2 AA (PRODUCT.md): after Next, keyboard and screen-reader users start on the new
    // step's first control rather than on a button below a panel that has just been replaced.
    const element = await form()
    fill(element, 'credential', PAYLOAD)
    await next(element)
    await element.updateComplete

    const place = element.querySelector('[data-step-panel="place"]')
    expect(place?.contains(document.activeElement)).toBe(true)
    expect(document.activeElement).toBe(element.querySelector('[data-field="room"]'))
  })

  it('moves focus to the first heading on Review', async () => {
    const element = await form()
    fillAll(element)
    await toReview(element)
    await element.updateComplete

    // The step's own heading, not the first card's: focus there would announce "Scan".
    const heading = document.activeElement as HTMLElement | null
    expect(heading?.tagName).toBe('H2')
    expect(element.querySelector('[data-step-panel="review"]')?.contains(heading)).toBe(true)
    expect(heading?.closest('[data-review]')).toBeNull()
    expect(heading?.textContent?.trim()).toBe('Save')
  })

  it('lands a save-time problem on its step with focus on the control in error', async () => {
    // The installation date sits second on Scan it; focus on the setup code above it would
    // make the person find the control the message is about.
    const element = await form()
    fillAll(element)
    await toReview(element)

    fill(element, 'installed-at', '2026-02-31')
    dispatchSubmit(element)
    await waitUntil(() => changedNotice(element), 'Save never refreshed Review')
    dispatchSubmit(element)
    await waitUntil(() => activeStep(element) === 'scan', 'Save never went to Scan it')
    await settle(element)

    expect(hintOf(element, 'installed-at')).toBe(errorText(element))
    expect(document.activeElement).toBe(element.querySelector('[data-field="installed-at"]'))
  })

  it('leaves focus alone when the form first opens', async () => {
    // Only a step *change* moves focus. Opening the form must not jump into a field, which
    // would scroll a phone and open its keyboard before the person has read the page.
    const element = await form()
    await settle(element)
    expect(element.contains(document.activeElement)).toBe(false)
  })

  it('lays the steps out in a row at every width', async () => {
    const element = await form()
    expect(stepper(element).orientation).toBe('horizontal')
  })
  it('goes to any step clicked, reached or not', async () => {
    const element = await form()
    expect(stepper(element).hasAttribute('linear')).toBe(false)

    ;(element.querySelector('wa-step[name="name"]') as HTMLElement).click()
    await settle(element)

    expect(activeStep(element)).toBe('name')
    expect(visible(element, '[data-step-panel="name"]')).toBe(true)
  })
})

/** Review's summary block for a step, which must exist. */
function reviewOf(element: HTMLElement, step: string): HTMLElement {
  const block = element.querySelector<HTMLElement>(`[data-review="${step}"]`)
  if (block === null) throw new Error(`no review block for "${step}"`)
  return block
}

/** Presses a review block's Edit, the way a person does. */
async function edit(element: AddDeviceView, step: string): Promise<void> {
  const button = reviewOf(element, step).querySelector<HTMLElement>('[data-edit]')
  if (button === null) throw new Error(`no Edit in the review block for "${step}"`)
  button.click()
  await settle(element)
}

/** Whether Review says that something changed behind it. */
function changedNotice(element: HTMLElement): boolean {
  return element.querySelector('[data-review-changed]') !== null
}

describe('reviewing before saving', () => {
  it('titles each card with an h3 under the hidden Review h2', async () => {
    const element = await form()
    fillAll(element)
    await toReview(element)
    for (const step of ['scan', 'place', 'name']) {
      const heading = reviewOf(element, step).querySelector('[slot="header"] > h3')
      expect(heading).not.toBeNull()
      expect(heading?.classList.contains('wa-heading-m')).toBe(true)
    }
  })

  it('shows what will be saved', async () => {
    const element = await form()
    fill(element, 'credential', PAYLOAD)
    fill(element, 'serial', 'SN-1')
    fill(element, 'installed-at', '2026-08-19')
    typeRoom(element, 'Ground Floor/Kitchen')
    fill(element, 'spot', 'ceiling')
    fill(element, 'name', 'Kitchen light')

    await toReview(element)

    expect(visible(element, '[data-review="scan"]')).toBe(true)
    expect(reviewOf(element, 'scan').textContent).toContain(PAYLOAD)
    expect(reviewOf(element, 'scan').textContent).toContain('SN-1')
    expect(reviewOf(element, 'place').textContent).toContain('Ground Floor/Kitchen')
    expect(reviewOf(element, 'place').textContent).toContain('ceiling')
    expect(reviewOf(element, 'name').textContent).toContain('Kitchen light')
    // Locale-formatted by the component rather than shown as the ISO string the control holds.
    const date = reviewOf(element, 'scan').querySelector('wa-format-date') as
      | (HTMLElement & { updateComplete: Promise<unknown> })
      | null
    expect(customElements.get('wa-format-date')).toBeDefined()
    expect(date?.getAttribute('date')).toContain('2026-08-19')
    await date?.updateComplete
    expect(date?.shadowRoot?.textContent).toContain('2026')
    expect(date?.shadowRoot?.textContent).toContain('19')
  })

  it('shows the manufacturer once the lookup has answered', async () => {
    const { api } = fakeCatalog(found)
    const element = await form(database.repositories, neverAvailable(), { api })
    typeCode(element, aqaraPayload())
    typeRoom(element, 'Hall')
    fill(element, 'name', 'Front door sensor')

    await toReview(element)

    await waitUntil(
      () => reviewOf(element, 'scan').querySelector('[data-catalog-manufacturer]') !== null,
      'Review never showed the manufacturer',
    )
    expect(reviewOf(element, 'scan').textContent).toContain('Aqara Home')
    expect(reviewOf(element, 'scan').textContent).toContain('Aqara Door and Window Sensor P2')
  })

  it('returns to the step from Edit, values intact, and back to Review with Next', async () => {
    const element = await form()
    fillAll(element)
    await toReview(element)

    await edit(element, 'place')
    expect(activeStep(element)).toBe('place')
    expect(fieldValue(element, 'spot')).toBe('ceiling, north end')
    await next(element)
    await next(element)
    expect(activeStep(element)).toBe('review')

    await edit(element, 'name')
    expect(activeStep(element)).toBe('name')
    expect(fieldValue(element, 'name')).toBe('Kitchen ceiling light')
    fill(element, 'name', 'Pantry light')
    await next(element)

    expect(activeStep(element)).toBe('review')
    // Read from the controls on entering Review, so the change shows rather than the old name.
    expect(reviewOf(element, 'name').textContent).toContain('Pantry light')
    expect(reviewOf(element, 'name').textContent).not.toContain('Kitchen ceiling light')
  })

  it('returns to Scan it from its Edit, values intact', async () => {
    const element = await form()
    fillAll(element)
    await toReview(element)

    await edit(element, 'scan')

    expect(activeStep(element)).toBe('scan')
    expect(fieldValue(element, 'credential')).toBe(PAYLOAD)
    expect(fieldValue(element, 'serial')).toBe('SN-000123')
    expect(fieldValue(element, 'installed-at')).toBe('2026-08-19')
  })

  it('refreshes Review rather than saving when a control changed behind it', async () => {
    const element = await form()
    fillAll(element)
    await toReview(element)
    expect(changedNotice(element)).toBe(false)

    fill(element, 'name', 'Pantry light')
    dispatchSubmit(element)
    await waitUntil(() => changedNotice(element), 'Save never refreshed Review')

    expect(await devices()).toHaveLength(0)
    expect(activeStep(element)).toBe('review')
    expect(reviewOf(element, 'name').textContent).toContain('Pantry light')

    dispatchSubmit(element)
    await waitUntil(async () => (await devices()).length === 1, 'the second Save stored nothing')
    expect((await devices())[0]?.name).toBe('Pantry light')
  })

  it('announces a second refresh to the live region, not only the first', async () => {
    // A live region speaks when its content changes. A notice already up whose text a second
    // refresh leaves alone is no change, so the second refresh would pass in silence (#353).
    const element = await form()
    fillAll(element)
    await toReview(element)
    fill(element, 'name', 'Pantry light')
    dispatchSubmit(element)
    await waitUntil(() => changedNotice(element), 'Save never refreshed Review')

    const region = element.querySelector('[data-step-panel="review"] [role="status"]')
    if (region === null) throw new Error('no live region on Review')
    // What the region held each time the browser delivered its mutations: the announcement is
    // proven only by an emptied region seen first, then the notice again in a later batch.
    const seen: string[] = []
    const observer = new MutationObserver(() => seen.push(region.textContent?.trim() ?? ''))
    observer.observe(region, { childList: true, subtree: true, characterData: true })
    try {
      fill(element, 'name', 'Larder light')
      dispatchSubmit(element)
      await waitUntil(
        () => seen.some((text, at) => text.includes('Something changed') && seen[at - 1] === ''),
        'the second refresh never reached the live region',
      )
    } finally {
      observer.disconnect()
    }
    expect(reviewOf(element, 'name').textContent).toContain('Larder light')
    expect(await devices()).toHaveLength(0)
  })

  it('drops a save still waiting on the rooms once the person leaves Review', async () => {
    // Save waits for the room re-read, and nothing holds the person on Review meanwhile. Edit,
    // a change, and Next back to Review build a new summary; were the waiting save to compare
    // against that, it would store the edit without the person pressing Save again.
    const rooms = deferred<void>()
    let holdRooms = false
    const real = database.repositories
    const element = await form({
      ...real,
      devices: {
        ...real.devices,
        list: async () => {
          if (holdRooms) await rooms.promise
          return real.devices.list()
        },
      },
    })
    fillAll(element)
    await toReview(element)

    holdRooms = true
    dispatchSubmit(element)
    await edit(element, 'name')
    fill(element, 'name', 'Pantry light')
    await next(element)
    expect(activeStep(element)).toBe('review')
    rooms.resolve()
    const save = element.querySelector('[data-save]') as HTMLButtonElement
    await waitUntil(() => !save.disabled, 'the waiting save never finished')

    expect(await devices()).toHaveLength(0)
    expect(activeStep(element)).toBe('review')

    dispatchSubmit(element)
    await waitUntil(async () => (await devices()).length === 1, 'the new Save stored nothing')
    expect((await devices())[0]?.name).toBe('Pantry light')
  })

  it('saves a code an image decoded after Review opened only once Review has shown it', async () => {
    // The decode can take seconds on a phone and nothing holds the person on Scan it, so the
    // code it finds can land in the hidden field while Review shows the one typed before.
    const element = await form()
    fillAll(element)
    const decoded = deferred<readonly string[]>()
    element.decodeImage = () => decoded.promise
    await chooseFile(element, pngFile())
    await toReview(element)
    expect(reviewOf(element, 'scan').textContent).toContain(PAYLOAD)

    decoded.resolve([aqaraPayload()])
    await waitUntil(
      () => fieldValue(element, 'credential') === aqaraPayload(),
      'the decoded code never reached the field',
    )
    dispatchSubmit(element)
    await waitUntil(() => changedNotice(element), 'Save never refreshed Review')

    expect(await devices()).toHaveLength(0)
    expect(reviewOf(element, 'scan').textContent).toContain(aqaraPayload())
    expect(reviewOf(element, 'scan').textContent).not.toContain(PAYLOAD)

    dispatchSubmit(element)
    await waitUntil(async () => (await devices()).length === 1, 'the second Save stored nothing')
    expect((await devices())[0]?.payload).toBe(aqaraPayload())
  })

  it('re-checks the steps when Save refreshes for a code decoded after it opened', async () => {
    // Reached with the setup code still empty and an image decoding: Scan is flagged. When the
    // decode lands and Save refreshes the summary, the verdicts must follow it - a card saying
    // the code is missing beside a valid code would send the person to fix what already works.
    const element = await form()
    fillAll(element)
    fill(element, 'credential', '')
    const decoded = deferred<readonly string[]>()
    element.decodeImage = () => decoded.promise
    await chooseFile(element, pngFile())
    await toReview(element)
    expect(flagged(element, 'scan')).toBe(true)
    expect(reviewOf(element, 'scan').dataset.status).toBe('problem')

    decoded.resolve([aqaraPayload()])
    await waitUntil(
      () => fieldValue(element, 'credential') === aqaraPayload(),
      'the decoded code never reached the field',
    )
    dispatchSubmit(element)
    await waitUntil(() => changedNotice(element), 'Save never refreshed')

    expect(flagged(element, 'scan')).toBe(false)
    expect(completed(element, 'scan')).toBe(true)
    expect(reviewOf(element, 'scan').dataset.status).toBe('complete')
    expect(reviewOf(element, 'scan').querySelector('[data-review-problem]')).toBeNull()
  })

  it('saves only from Review', async () => {
    const element = await form()
    fillAll(element)
    await settle(element)

    for (const step of ['scan', 'place', 'name']) {
      expect(activeStep(element)).toBe(step)
      expect(element.querySelector('[data-save]'), step).toBeNull()
      await next(element)
    }
    expect(activeStep(element)).toBe('review')
    expect(element.querySelector('[data-save]')).not.toBeNull()
  })

  it('lands a save-time room problem on Place it', async () => {
    // A value changed after its step passed and never checked again - here the room control,
    // hidden on Review - reaches `planNewDevice` on Save. Its message has to appear beside the
    // room, which means on Place it, not above a summary with no room control in it.
    const element = await form()
    fillAll(element)
    await toReview(element)

    typeRoom(element, '/')
    // The first Save sees the room differ from what Review shows, and shows it instead.
    dispatchSubmit(element)
    await waitUntil(() => changedNotice(element), 'Save never refreshed Review')
    expect(activeStep(element)).toBe('review')
    expect(reviewOf(element, 'place').textContent).toContain('/')
    // The second is planned, and `planNewDevice` refuses the room.
    dispatchSubmit(element)
    await waitUntil(() => activeStep(element) === 'place', 'Save never went to Place it')
    await settle(element)

    expect(errorText(element)).toBeTruthy()
    expect(hintOf(element, 'room')).toBe(errorText(element))
    expect(completed(element, 'place')).toBe(false)
    expect(await devices()).toHaveLength(0)
  })
})

/** The `data-field` of every control marked `required`, sorted. */
const requiredFields = (element: HTMLElement): (string | null)[] =>
  [...element.querySelectorAll('[data-field][required]')]
    .map((control) => control.getAttribute('data-field'))
    .sort()

describe('the mandatory fields', () => {
  it('marks the setup code, name, room and installation date, and nothing else', async () => {
    // `required` is what makes Web Awesome draw the asterisk and set `aria-required`. Spot and
    // serial are optional, and an asterisk on them would send people hunting for a value.
    const element = await form()
    expect(requiredFields(element)).toEqual(['credential', 'installed-at', 'name', 'room'])
    expect(element.querySelector('[data-field="spot"]')?.hasAttribute('required')).toBe(false)
    expect(element.querySelector('[data-field="serial"]')?.hasAttribute('required')).toBe(false)
  })

  it('says once what the asterisk means', async () => {
    const element = await form()
    expect(element.querySelector('[data-required-note]')?.textContent?.trim()).toBe(
      'Fields marked * are required.',
    )
  })

  it('says it in German too', async () => {
    await activateLocale('de')
    try {
      const element = await form()
      expect(element.querySelector('[data-required-note]')?.textContent?.trim()).toBe(
        'Mit * markierte Felder sind Pflichtfelder.',
      )
    } finally {
      await activateLocale('en')
    }
  })

  it('names the steps in German', async () => {
    await activateLocale('de')
    try {
      const element = await form()
      const labels = [...element.querySelectorAll('wa-step')].map((s) => s.textContent?.trim())
      expect(labels).toEqual(['Scannen', 'Platzieren', 'Benennen', 'Speichern'])
      // The step is the verb; the field it holds keeps the noun. One English word, two German
      // ones - which is why the step label carries an id of its own.
      expect(element.querySelector('[data-field="name"]')?.getAttribute('label')).toBe('Name')
      expect(element.querySelector('[data-next]')?.textContent?.trim()).toBe('Weiter')
      fillAll(element)
      await next(element)
      expect(element.querySelector('[data-back]')?.textContent?.trim()).toBe('Zurück')
      await next(element)
      await next(element)
      expect(element.querySelector('[data-edit]')?.textContent).toContain('Bearbeiten')
    } finally {
      await activateLocale('en')
    }
  })

  it("keeps the browser's own validation out of the way", async () => {
    // `novalidate`: the planner's messages name the problem; the browser's generic bubble would
    // arrive first and say less.
    const element = await form()
    expect(element.querySelector('form')?.hasAttribute('novalidate')).toBe(true)
  })
})

describe('a write storage refuses', () => {
  it('stays on the form and says so, rather than navigating as though it saved', async () => {
    // Navigating to a list that does not contain the device is the application saying it
    // saved something it did not - and what it did not save is a code that cannot be recreated.
    // Still on the form, on Review, where Save was pressed.
    const element = await form(refusingWrites())
    fill(element, 'credential', PAYLOAD)
    fill(element, 'name', 'Kitchen ceiling light')
    typeRoom(element, 'Ground Floor/Kitchen')

    await submit(element, () => element.querySelector('[data-save-failed]') !== null)

    expect(await devices()).toHaveLength(0)
    expect(window.location.hash).toBe(`${FORM}?step=review`)
    expect(fieldValue(element, 'credential')).toBe(PAYLOAD)
  })
})

describe('a refreshed Review, then a write storage refuses', () => {
  it('drops the "something changed" notice once Save gets past the comparison', async () => {
    // The notice is about the last Save; a later one that matched what Review shows, and then
    // failed in storage, must show the storage error alone rather than both side by side.
    const element = await form(refusingWrites())
    fillAll(element)
    await toReview(element)

    fill(element, 'name', 'Pantry light')
    dispatchSubmit(element)
    await waitUntil(() => changedNotice(element), 'Save never refreshed Review')

    dispatchSubmit(element)
    await waitUntil(
      () => element.querySelector('[data-save-failed]') !== null,
      'the refused write was never reported',
    )
    expect(changedNotice(element)).toBe(false)
  })

  it('keeps the notice down when that Save comes before the notice is back', async () => {
    // A refresh puts the notice back only after a gap (#353). A matching Save inside it has
    // already said the notice is no longer true, so the gap must not end by showing it. The gap
    // is lengthened so that the matching Save is sure to land inside it.
    const gap = 1000
    const element = await form(refusingWrites())
    element.reviewChangedGapMs = gap
    fillAll(element)
    await toReview(element)
    const save = element.querySelector('[data-save]') as HTMLButtonElement

    fill(element, 'name', 'Pantry light')
    const refreshed = performance.now()
    dispatchSubmit(element)
    await waitUntil(() => reviewOf(element, 'name').textContent?.includes('Pantry light'))
    await waitUntil(() => !save.disabled, 'the refreshing Save never finished')
    dispatchSubmit(element)
    await waitUntil(
      () => element.querySelector('[data-save-failed]') !== null,
      'the refused write was never reported',
    )
    // Still inside the gap: the notice was pending, not yet shown, when that Save matched.
    expect(performance.now() - refreshed).toBeLessThan(gap)
    expect(changedNotice(element)).toBe(false)

    await new Promise((resolve) => setTimeout(resolve, gap + 100))
    expect(changedNotice(element)).toBe(false)
  })
})

describe('a project locked on this device', () => {
  it('says the device cannot be filed until the key arrives, and keeps what was typed', async () => {
    const encrypted = await lockedDatabase()
    try {
      // Still on the form, on Review, where Save was pressed.
      const element = await form(encrypted.locked)
      fill(element, 'credential', PAYLOAD)
      fill(element, 'name', 'Kitchen ceiling light')
      typeRoom(element, 'Ground Floor/Kitchen')

      await submit(element, () => element.querySelector('[data-save-locked]') !== null)

      expect(element.querySelector('[data-save-locked]')?.textContent).toContain(
        'after the next sync',
      )
      expect(element.querySelector('[data-save-failed]')).toBeNull()
      expect(window.location.hash).toBe(`${FORM}?step=review`)
      expect(fieldValue(element, 'credential')).toBe(PAYLOAD)
      expect(await encrypted.unlocked.devices.list()).toHaveLength(0)
    } finally {
      await encrypted.destroy()
    }
  })
})

describe('a locked refusal on the add form, once the key arrives', () => {
  it('clears when the project’s documents change, and the next save files the device', async () => {
    const encrypted = await lockedDatabase()
    try {
      const element = await form(encrypted.unlockable)
      fill(element, 'credential', PAYLOAD)
      fill(element, 'name', 'Kitchen ceiling light')
      typeRoom(element, 'Ground Floor/Kitchen')
      await submit(element, () => element.querySelector('[data-save-locked]') !== null)

      encrypted.unlock()
      window.dispatchEvent(new CustomEvent(PROJECT_DATA_CHANGED))

      await waitUntil(
        () => element.querySelector('[data-save-locked]') === null,
        'the stale refusal stayed on screen after the key arrived',
      )
      expect(fieldValue(element, 'credential')).toBe(PAYLOAD)
    } finally {
      await encrypted.destroy()
    }
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
    expect(formUpload(element)).not.toBeNull()
  })

  it('offers Scan and no form upload when this browser can scan', async () => {
    // One control, not two side by side: where the camera works, uploading is the scan
    // dialog's fallback for a label the camera cannot read, and it stays there.
    const element = await form(database.repositories, scanningSource(PAYLOAD))
    await waitUntil(() => element.scanChecked, 'the scan check never finished')
    await element.updateComplete

    expect(element.querySelector('[data-scan]')).not.toBeNull()
    expect(formUpload(element)).toBeNull()

    ;(element.querySelector('[data-scan]') as HTMLElement).click()
    await element.updateComplete
    expect(element.querySelector('[data-scan-dialog] [data-upload]')).not.toBeNull()
  })

  it('offers neither until the camera check finishes', async () => {
    // A button that swaps from Upload to Scan under the thumb, as the check lands on a phone,
    // is worse than a moment with neither. The field itself does not wait.
    const answer = deferred<boolean>()
    const source: ScanSource = { ...scanningSource(PAYLOAD), available: () => answer.promise }
    const element = await form(database.repositories, source)
    await element.updateComplete

    expect(element.scanChecked).toBe(false)
    expect(element.querySelector('[data-scan]')).toBeNull()
    expect(formUpload(element)).toBeNull()
    fill(element, 'credential', PAYLOAD)
    expect(fieldValue(element, 'credential')).toBe(PAYLOAD)

    answer.resolve(true)
    await waitUntil(() => element.querySelector('[data-scan]') !== null, 'Scan never appeared')
    expect(formUpload(element)).toBeNull()
  })

  it('falls back to Upload when the camera check never answers (#352)', async () => {
    // A probe that hangs - the ZXing chunk stalled on a bad connection, a camera API that
    // never settles - would otherwise leave the form with no way to read the label at all.
    const never: ScanSource = { ...scanningSource(PAYLOAD), available: () => new Promise(() => {}) }
    const element = await formTimingOut(never)
    await element.updateComplete
    expect(formUpload(element)).toBeNull()

    await waitUntil(() => formUpload(element) !== null, 'Upload never appeared after the timeout')
    expect(element.querySelector('[data-scan]')).toBeNull()
  })

  it('keeps Upload once shown, even if the camera check answers yes later', async () => {
    // The promise the wait for the check makes: no button swapped out from under a thumb
    // already on its way to it.
    const answer = deferred<boolean>()
    const late: ScanSource = { ...scanningSource(PAYLOAD), available: () => answer.promise }
    const element = await formTimingOut(late)
    await waitUntil(() => formUpload(element) !== null, 'Upload never appeared after the timeout')

    answer.resolve(true)
    await answer.promise
    await element.updateComplete

    expect(element.canScan).toBe(false)
    expect(element.querySelector('[data-scan]')).toBeNull()
    expect(formUpload(element)).not.toBeNull()
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

  it('fills the setup code from a scan finished after going back', async () => {
    // Back from Place it to Scan it, then the camera: the code lands in the field the person
    // is looking at, and Scan it keeps the checkmark that lets the later steps be reached.
    const element = await form(database.repositories, scanningSource(PAYLOAD))
    fill(element, 'credential', SHORT_CODE)
    await next(element)
    expect(activeStep(element)).toBe('place')

    element.goToStep('scan')
    await settle(element)
    expect(activeStep(element)).toBe('scan')
    await waitUntil(() => element.querySelector('[data-scan]') !== null, 'no scan control')
    ;(element.querySelector('[data-scan]') as HTMLElement).click()

    await waitUntil(() => fieldValue(element, 'credential') === PAYLOAD, 'the code never arrived')
    await settle(element)
    expect(completed(element, 'scan')).toBe(true)
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

  it('says "Test vendor" in German for a test vendor’s answer', async () => {
    const testVendor: LookupOutcome = {
      kind: 'found',
      lookup: {
        vendorId: 0xfff1,
        productId: 0x8000,
        source: 'test-vendor',
        vendor: { name: 'Test vendor', preferredName: null, legalName: null, landingPageUrl: null },
        product: null,
        fetchedAt: '2026-10-05T16:20:00.000Z',
        stale: false,
      },
    }
    const { api } = fakeCatalog(() => Promise.resolve(testVendor))
    await activateLocale('de')
    try {
      const element = await form(database.repositories, neverAvailable(), { api })
      typeCode(element, PAYLOAD)
      await waitUntil(() => element.querySelector('[data-catalog]') !== null, 'no names')
      expect(element.querySelector('[data-catalog-manufacturer]')?.textContent).toBe(
        'Testhersteller',
      )
      element.remove()
    } finally {
      await activateLocale('en')
    }
  })

  it('keeps a settled answer when the form is detached and attached again', async () => {
    const { api, calls } = fakeCatalog(found)
    const element = await form(database.repositories, neverAvailable(), { api })
    typeCode(element, aqaraPayload())
    await waitUntil(() => element.querySelector('[data-catalog]') !== null, 'no names')

    // Moved rather than destroyed. Nothing changes a field afterwards, so nothing would ask again.
    element.remove()
    document.body.append(element)
    await element.updateComplete

    expect(element.querySelector('[data-catalog-manufacturer]')?.textContent).toBe('Aqara Home')
    expect(element.querySelector('[data-catalog-product]')?.textContent).toBe(
      'Aqara Door and Window Sensor P2',
    )
    fill(element, 'name', 'Front door sensor')
    typeRoom(element, 'Hall')
    await submit(element, async () => (await devices()).length === 1)
    expect((await devices())[0]?.vendorName).toBe('Aqara')
    expect(calls).toHaveLength(1)
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

describe('switching project while a save is planned', () => {
  afterEach(() => {
    window.location.hash = ''
  })

  it('writes nothing when the project changes during the room re-read', async () => {
    // The save waits for the rooms before it plans. A switch in that wait must not let the
    // device typed under one project be written once the form resolves the next project's
    // database (#291 review).
    const real = database.repositories
    const reread = deferred<DeviceDocument[]>()
    let lists = 0
    let saves = 0
    const repositories: ProjectRepositories = {
      ...real,
      devices: {
        ...real.devices,
        list: () => (++lists === 1 ? real.devices.list() : reread.promise),
        save: async (device) => {
          saves += 1
          return real.devices.save(device)
        },
      },
    }
    const element = await form(repositories)
    typeCode(element, PAYLOAD)
    fill(element, 'name', 'Lamp')
    typeRoom(element, 'Kitchen')
    // Saving happens on Review only; the steps in between write nothing and read no rooms.
    await next(element)
    await next(element)
    await next(element)

    dispatchSubmit(element)
    await waitUntil(() => lists >= 2, 'the save never re-read the rooms')
    window.dispatchEvent(new CustomEvent(PROJECT_CHANGED))
    reread.resolve([])
    await waitUntil(() => !element.saving, 'the save never settled')

    expect(saves).toBe(0)
    expect(await devices()).toEqual([])
  })
})
