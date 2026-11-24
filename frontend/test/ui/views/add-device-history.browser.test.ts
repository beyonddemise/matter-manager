/**
 * The add form and the browser's history (#356): each step is an entry, so Back moves one step
 * back and Forward one step on, with every value kept, and leaving with something entered asks
 * first.
 *
 * Through the real History API rather than a fake, because what can go wrong is the browser's
 * part: which events a traversal fires, and in what order. Each test starts from two entries of
 * its own (`#/start`, then the form's `#/devices/new`), so that no traversal here can walk out
 * of this frame's history into the runner's.
 */
import '@awesome.me/webawesome-pro/dist/components/button/button.js'
import '@awesome.me/webawesome-pro/dist/components/callout/callout.js'
import '@awesome.me/webawesome-pro/dist/components/combobox/combobox.js'
import '@awesome.me/webawesome-pro/dist/components/dialog/dialog.js'
import '@awesome.me/webawesome-pro/dist/components/icon/icon.js'
import '@awesome.me/webawesome-pro/dist/components/input/input.js'
import '@awesome.me/webawesome-pro/dist/components/option/option.js'
import { fixture, fixtureCleanup, html, waitUntil } from '@open-wc/testing-helpers'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { DeviceDocument } from '../../../src/domain/index.js'
import { PROJECT_CHANGED } from '../../../src/ui/current-project.js'
import type { ScanSource } from '../../../src/ui/scan/source.js'
import type { AddDeviceView } from '../../../src/ui/views/add-device.js'
import '../../../src/ui/views/add-device.js'
import { browserDatabase, type TestDatabase } from '../support/browser-database.js'

const PAYLOAD = 'MT:Y.K9042C00KA0648G00'
const FORM = '#/devices/new'

let database: TestDatabase

beforeEach(() => {
  database = browserDatabase()
  // Two entries of this test's own, neither stamped by an earlier form.
  history.replaceState(null, '', '#/start')
  history.pushState(null, '', FORM)
})

afterEach(async () => {
  // A form still walking its history back would otherwise do it in the next test.
  for (const element of document.querySelectorAll<AddDeviceView>('add-device-view')) {
    await waitUntil(() => element.historySettled, 'a form never settled its history')
  }
  fixtureCleanup()
  await database.destroy()
})

const neverAvailable = (): ScanSource => ({
  available: async () => false,
  open: async () => {
    throw new Error('never opened')
  },
  read: async () => [],
  close: () => {},
})

async function form(): Promise<AddDeviceView> {
  await customElements.whenDefined('wa-input')
  const element = (await fixture(
    html`<add-device-view
      .repositories=${database.repositories}
      .scanSource=${neverAvailable()}
      .signedIn=${() => false}
    ></add-device-view>`,
  )) as AddDeviceView
  await settle(element)
  return element
}

function stepper(element: HTMLElement): HTMLElement & {
  active: string
  updateComplete: Promise<unknown>
} {
  return element.querySelector('wa-stepper') as never
}

const activeStep = (element: HTMLElement): string => stepper(element).active

async function settle(element: AddDeviceView): Promise<void> {
  await element.updateComplete
  await stepper(element).updateComplete
  await element.updateComplete
}

function fill(element: HTMLElement, field: string, value: string): void {
  const control = element.querySelector(`[data-field="${field}"]`) as { value?: string } | null
  if (control === null) throw new Error(`no control for "${field}"`)
  control.value = value
}

function typeRoom(element: HTMLElement, path: string): void {
  ;(element.querySelector('[data-field="room"]') as { inputValue?: string }).inputValue = path
}

function shown(element: HTMLElement, field: string): string {
  const control = element.querySelector(`[data-field="${field}"]`) as {
    value?: unknown
    inputValue?: unknown
  }
  const value = field === 'room' ? control.inputValue : control.value
  return typeof value === 'string' ? value : ''
}

async function press(element: AddDeviceView, selector: string): Promise<void> {
  const button = element.querySelector<HTMLElement>(selector)
  if (button === null) throw new Error(`nothing matches ${selector}`)
  button.click()
  await settle(element)
}

const next = (element: AddDeviceView) => press(element, '[data-next]')

/** Waits until the address and the stepper both say `step`. */
async function on(element: AddDeviceView, step: string): Promise<void> {
  const address = step === 'scan' ? FORM : `${FORM}?step=${step}`
  await waitUntil(
    () => activeStep(element) === step && location.hash === address && element.historySettled,
    `never settled on ${step}: stepper ${activeStep(element)}, address ${location.hash}`,
  )
  await settle(element)
}

/** The browser's Back button, and the step it should land on. */
async function back(element: AddDeviceView, landing: string): Promise<void> {
  history.back()
  await on(element, landing)
}

async function forward(element: AddDeviceView, landing: string): Promise<void> {
  history.forward()
  await on(element, landing)
}

function flagged(element: HTMLElement, step: string): boolean {
  return element.querySelector(`wa-step[name="${step}"] [data-step-problem]`) !== null
}

function fillAll(element: HTMLElement): void {
  fill(element, 'credential', PAYLOAD)
  typeRoom(element, 'Ground Floor/Kitchen')
  fill(element, 'name', 'Kitchen ceiling light')
}

describe('a history entry per step', () => {
  it('gives each step its own address', async () => {
    const element = await form()
    expect(location.hash).toBe(FORM)

    await next(element)
    await on(element, 'place')
    await next(element)
    await on(element, 'name')
    await next(element)
    await on(element, 'review')
  })

  it('moves Back one step at a time, keeping everything entered', async () => {
    const element = await form()
    fillAll(element)
    await next(element)
    await next(element)
    await next(element)
    await on(element, 'review')

    await back(element, 'name')
    expect(shown(element, 'name')).toBe('Kitchen ceiling light')
    await back(element, 'place')
    expect(shown(element, 'room')).toBe('Ground Floor/Kitchen')
    await back(element, 'scan')
    expect(shown(element, 'credential')).toBe(PAYLOAD)
  })

  it('moves Forward again, checking each step it leaves', async () => {
    const element = await form()
    await next(element)
    await on(element, 'place')
    await back(element, 'scan')
    // Back on Scan shows its own problem; the flag stays until the step passes on leaving.
    fill(element, 'credential', PAYLOAD)

    await forward(element, 'place')

    expect(flagged(element, 'scan')).toBe(false)
    fill(element, 'credential', '')
    await back(element, 'scan')
    await forward(element, 'place')
    expect(flagged(element, 'scan')).toBe(true)
  })

  it('keeps the Previous button and browser Back the same move', async () => {
    // Previous takes the history back with it, so Forward afterwards returns to the step it
    // left - not to a step after it, which a pushed entry would give.
    const element = await form()
    fillAll(element)
    await next(element)
    await next(element)
    await on(element, 'name')

    await press(element, '[data-back]')
    await on(element, 'place')
    await back(element, 'scan')
    await forward(element, 'place')
    await forward(element, 'name')
  })

  it('walks the history back with a jump, so Back stays the previous step', async () => {
    const element = await form()
    fillAll(element)
    await next(element)
    await next(element)
    await next(element)
    await on(element, 'review')

    await press(element, '[data-review="place"] [data-edit]')
    await on(element, 'place')

    await back(element, 'scan')
    await forward(element, 'place')
    await forward(element, 'name')
  })

  it('gives a jump forward an entry for each step it passes', async () => {
    const element = await form()
    fillAll(element)

    await press(element, 'wa-step[name="review"]')
    await on(element, 'review')

    await back(element, 'name')
    await back(element, 'place')
  })
})

describe('arriving on a later step', () => {
  it('lands on step 1 from an address naming a later step', async () => {
    // A deep link or a bookmark: nothing entered, so a later step would be an empty one.
    history.replaceState(null, '', `${FORM}?step=name`)

    const element = await form()

    await on(element, 'scan')
  })

  it('lands on step 1 after a reload, and Back then leaves the form', async () => {
    // A reload on Name: the entries before it are the form's own, from before the reload. The
    // form goes back to its first one, so Back is not three presses of an empty step 1.
    const id = 'form-before-reload'
    history.replaceState({ addDevice: id, step: 'scan' }, '', FORM)
    history.pushState({ addDevice: id, step: 'place' }, '', `${FORM}?step=place`)
    history.pushState({ addDevice: id, step: 'name' }, '', `${FORM}?step=name`)

    const element = await form()
    await on(element, 'scan')

    history.back()
    await waitUntil(() => location.hash === '#/start', `Back went to ${location.hash}`)
  })
})

describe('saving', () => {
  it('replaces the form in the history, so Back does not return to it', async () => {
    const element = await form()
    fillAll(element)
    await next(element)
    await next(element)
    await next(element)
    await on(element, 'review')

    await press(element, '[data-save]')
    await waitUntil(() => location.hash === '#/devices', `saving went to ${location.hash}`)
    expect(((await database.repositories.devices.list()) as DeviceDocument[]).length).toBe(1)

    history.back()
    await waitUntil(() => location.hash === '#/start', `Back went to ${location.hash}`)
  })

  it('saves nothing more once it has saved, while the form is still on screen', async () => {
    // Leaving takes a traversal, and the shell removes the form only once it lands. A second
    // Save in that moment would file the same device twice.
    const element = await form()
    fillAll(element)
    await press(element, 'wa-step[name="review"]')
    await on(element, 'review')
    await press(element, '[data-save]')
    await waitUntil(() => !element.saving && location.hash === '#/devices', 'never saved')

    element
      .querySelector('form')
      ?.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }))
    await waitUntil(() => !element.saving)
    await new Promise((resolve) => setTimeout(resolve, 200))

    expect(await database.repositories.devices.list()).toHaveLength(1)
  })
})

describe('leaving with something entered', () => {
  it('holds nothing on a form nobody has typed into, even on a later step', async () => {
    const element = await form()
    await next(element)
    expect(element.holdsInput()).toBe(false)
  })

  it('holds what was typed into any step, and a date changed from today', async () => {
    for (const [field, value] of [
      ['credential', PAYLOAD],
      ['serial', 'SN-1'],
      ['installed-at', '2020-01-01'],
      ['spot', 'ceiling'],
      ['name', 'Lamp'],
    ] as const) {
      const element = await form()
      fill(element, field, value)
      expect(element.holdsInput(), field).toBe(true)
    }
    const element = await form()
    typeRoom(element, 'Hall')
    expect(element.holdsInput()).toBe(true)
  })

  it('asks, with Stay focused, and keeps the input on Stay', async () => {
    const element = await form()
    fill(element, 'credential', PAYLOAD)

    const answer = element.confirmLeave()
    const dialog = element.querySelector('[data-leave-dialog]') as HTMLElement & { open: boolean }
    await waitUntil(() => dialog.open, 'the dialog never opened')
    const stay = element.querySelector<HTMLElement>('[data-leave-stay]')
    await waitUntil(() => document.activeElement === stay, 'Stay was never focused')
    stay?.click()

    expect(await answer).toBe(false)
    await waitUntil(() => !dialog.open, 'the dialog never closed')
    expect(element.holdsInput()).toBe(true)
    expect(shown(element, 'credential')).toBe(PAYLOAD)
  })

  it('counts closing the dialog as Stay', async () => {
    const element = await form()
    fill(element, 'credential', PAYLOAD)
    const answer = element.confirmLeave()
    const dialog = element.querySelector('[data-leave-dialog]') as HTMLElement & { open: boolean }
    await waitUntil(() => dialog.open, 'the dialog never opened')

    dialog.open = false

    expect(await answer).toBe(false)
  })

  it('answers Discard, and lets go only once released', async () => {
    // Discard may still lead nowhere (Forward came back while it was asked), so the answer
    // alone lets nothing go: the shell releases the form as it actually leaves.
    const element = await form()
    fill(element, 'credential', PAYLOAD)
    const answer = element.confirmLeave()
    await waitUntil(() => element.querySelector('[data-leave-dialog]')?.hasAttribute('open'))

    element.querySelector<HTMLElement>('[data-leave-discard]')?.click()

    expect(await answer).toBe(true)
    expect(element.holdsInput()).toBe(true)
    element.release()
    expect(element.holdsInput()).toBe(false)
  })

  it('withdraws an open question when it lets go on its own', async () => {
    const element = await form()
    fill(element, 'credential', PAYLOAD)
    const answer = element.confirmLeave()
    await waitUntil(() => element.querySelector('[data-leave-dialog]')?.hasAttribute('open'))

    window.dispatchEvent(new CustomEvent(PROJECT_CHANGED))

    expect(await answer).toBe(false)
    expect(element.holdsInput()).toBe(false)
    // And its entries stay gone: there is nothing to put back for a form on its way out.
    const before = location.hash
    element.restoreAddress()
    expect(location.hash).toBe(before)
  })

  it('asks the browser to confirm a reload or a closed tab, only with input', async () => {
    const element = await form()
    const unload = () => {
      const event = new Event('beforeunload', { cancelable: true })
      window.dispatchEvent(event)
      return event.defaultPrevented
    }
    expect(unload()).toBe(false)
    fill(element, 'name', 'Lamp')
    expect(unload()).toBe(true)
  })

  it('puts its entries back when the person stays after the browser left', async () => {
    // Back from step 1 has already moved the address by the time anyone can ask. Staying
    // puts every step up to the current one back, so Back is still the previous step.
    const element = await form()
    fillAll(element)
    await next(element)
    await on(element, 'place')
    history.replaceState(null, '', '#/elsewhere')

    element.restoreAddress()

    expect(location.hash).toBe(`${FORM}?step=place`)
    await back(element, 'scan')
  })
})
