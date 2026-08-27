// The theme, as `main.ts` loads it. Without it the `--wa-*` tokens are undefined, so a
// declaration using one is dropped entirely and a computed style reads as though the rule were
// missing — a test that would report a stylesheet bug that does not exist, and hide one that
// does.
import '@awesome.me/webawesome-pro/dist/styles/webawesome.css'
import '@awesome.me/webawesome-pro/dist/styles/themes/glossy.css'
import '@awesome.me/webawesome-pro/dist/styles/color/palettes/anodized.css'
import '@awesome.me/webawesome-pro/dist/components/badge/badge.js'
import '@awesome.me/webawesome-pro/dist/components/button/button.js'
import '@awesome.me/webawesome-pro/dist/components/checkbox/checkbox.js'
import '@awesome.me/webawesome-pro/dist/components/icon/icon.js'
import '@awesome.me/webawesome-pro/dist/components/input/input.js'
import '@awesome.me/webawesome-pro/dist/components/page/page.js'
import '@awesome.me/webawesome-pro/dist/components/tag/tag.js'
import { fixture, html, waitUntil } from '@open-wc/testing-helpers'
import { cdp } from '@vitest/browser/context'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import '../src/app-shell.js'
import '../src/styles/app.css'
import type { DeviceListView } from '../src/views/device-list.js'
import '../src/views/device-list.js'
import { browserDatabase, type TestDatabase } from './support/browser-database.js'

/**
 * The print stylesheet, with the browser actually in print mode.
 *
 * Emulated through CDP rather than inspected as CSS text. A test that read the stylesheet and
 * asserted "there is a rule hiding the navigation" would pass against a rule with a typo in
 * its selector, one overridden by specificity, or one inside a media query that never matches
 * — which is every way a print stylesheet actually fails. Computed styles under emulated print
 * media answer the question that matters: *what would come out of the printer.*
 */

let database: TestDatabase

/**
 * Switches the browser between print and screen media.
 *
 * Cast because this version of Vitest declares `CDPSession` as an empty interface — the object
 * has `send`, the type does not say so. Narrowed to the one method used rather than cast to
 * `any`, so a future Vitest that types this properly produces a compile error here instead of
 * silently drifting.
 */
const emulate = (media: 'print' | '') =>
  (cdp() as unknown as { send: (method: string, params: unknown) => Promise<unknown> }).send(
    'Emulation.setEmulatedMedia',
    { media },
  )

beforeEach(async () => {
  database = browserDatabase()
  await emulate('print')
})

afterEach(async () => {
  // Restored even when a case fails: leaving the browser in print media would make every
  // later test in this worker run against a stylesheet it was not written for.
  await emulate('')
  await database.destroy()
})

const device = (id: string, name: string, roomId: string, extra = {}) => ({
  _id: id,
  type: 'device' as const,
  name,
  roomId,
  manualCode: '34970112332',
  installedAt: '2026-08-26',
  addedAt: '2026-08-26T09:00:00.000Z',
  disabled: false,
  remarks: [],
  ...extra,
})

async function seed(): Promise<void> {
  const { rooms, devices } = database.repositories
  await rooms.save({ _id: 'room:kitchen', type: 'room', path: 'Ground Floor/Kitchen' })
  await devices.save(device('device:ceiling', 'Ceiling light', 'room:kitchen'))
  await devices.save(device('device:extractor', 'Extractor', 'room:kitchen'))
  await devices.save(device('device:old', 'Old sensor', 'room:kitchen', { disabled: true }))
}

async function list(): Promise<DeviceListView> {
  await customElements.whenDefined('wa-input')
  const element = (await fixture(
    html`<device-list-view .repositories=${database.repositories}></device-list-view>`,
  )) as DeviceListView
  await waitUntil(() => element.loaded, 'the device list never finished its first read')
  await element.updateComplete
  return element
}

const hidden = (element: Element | null): boolean =>
  element === null || getComputedStyle(element).display === 'none'

describe('printing the device list', () => {
  it('is genuinely in print mode', async () => {
    // The positive control. Every assertion below is "this is hidden when printing", and every
    // one of them would also pass if the emulation silently did nothing and the element simply
    // was not there. This one fails first if the media query is not matching at all.
    expect(matchMedia('print').matches).toBe(true)
  })

  it('leaves out the controls, which cannot be used on paper', async () => {
    // A search box printed with a cursor in it looks like a bug; an export button on paper is
    // an instruction nobody can follow.
    await seed()
    const element = await list()

    for (const selector of [
      '[data-search]',
      '[data-include-disabled]',
      '[data-export]',
      '[data-labels]',
    ]) {
      expect(hidden(element.querySelector(selector)), selector).toBe(true)
    }
  })

  it('leaves out the per-device checkboxes', async () => {
    // They are for choosing what to export, and there is nothing to choose on paper.
    await seed()
    const element = await list()

    expect(hidden(element.querySelector('[data-select]'))).toBe(true)
  })

  it('keeps the devices, which are the content', async () => {
    await seed()
    const element = await list()

    const row = element.querySelector('[data-device-id="device:ceiling"]')
    expect(row).not.toBeNull()
    expect(getComputedStyle(row as Element).display).not.toBe('none')
    expect(element.textContent).toContain('Ceiling light')
    expect(element.textContent).toContain('Ground Floor/Kitchen')
  })

  it('does not split a device across a page boundary', async () => {
    // Half a name and half a serial number read as a different device, which is worse than
    // omitting it.
    await seed()
    const element = await list()
    const row = element.querySelector('[data-device-id="device:ceiling"]') as Element

    expect(getComputedStyle(row).breakInside).toBe('avoid')
  })

  it('keeps a room heading with the devices under it', async () => {
    // A heading at the foot of a page above nothing reads as an empty room — the same failure
    // the PDF layout guards against, and the same remedy.
    await seed()
    const element = await list()
    const heading = element.querySelector('.app-room-heading') as Element

    expect(getComputedStyle(heading).breakAfter).toBe('avoid')
  })

  it('still marks a disabled device as disabled', async () => {
    // The screen distinguishes it by a tint that will not survive `background: transparent`,
    // so on paper the border does the work. A printed list where a decommissioned device looks
    // live is a list that sends somebody to a wall socket.
    await seed()
    const element = await list()
    const toggle = element.querySelector('[data-include-disabled]') as HTMLElement & {
      checked?: boolean
    }
    toggle.checked = true
    toggle.dispatchEvent(new Event('change', { bubbles: true }))
    await element.updateComplete

    const row = element.querySelector('[data-device-id="device:old"] .app-device') as Element
    expect(getComputedStyle(row).borderStyle).toBe('dashed')
  })
})

describe('printing the shell', () => {
  it('leaves out the navigation and the header', async () => {
    await customElements.whenDefined('wa-page')
    const shell = await fixture(html`<app-shell></app-shell>`)

    expect(hidden(shell.querySelector('[slot="navigation"]'))).toBe(true)
    expect(hidden(shell.querySelector('[slot="header"]'))).toBe(true)
  })

  it('does not confine the page to one scrolling viewport', async () => {
    // `<wa-page>` is a fixed application frame. Printed as one it yields a single page
    // containing whatever was in the viewport — the classic "only the first page prints"
    // bug, which is a scrolling-container problem rather than a clipping one.
    await customElements.whenDefined('wa-page')
    const shell = await fixture(html`<app-shell></app-shell>`)
    const page = shell.querySelector('wa-page') as Element

    const style = getComputedStyle(page)
    expect(style.overflow).toBe('visible')
    expect(style.position).toBe('static')
  })
})
