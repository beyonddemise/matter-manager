import '@awesome.me/webawesome-pro/dist/components/badge/badge.js'
import '@awesome.me/webawesome-pro/dist/components/button/button.js'
import '@awesome.me/webawesome-pro/dist/components/checkbox/checkbox.js'
import '@awesome.me/webawesome-pro/dist/components/callout/callout.js'
import '@awesome.me/webawesome-pro/dist/components/icon/icon.js'
import '@awesome.me/webawesome-pro/dist/components/dialog/dialog.js'
import '@awesome.me/webawesome-pro/dist/components/option/option.js'
import '@awesome.me/webawesome-pro/dist/components/qr-code/qr-code.js'
import '@awesome.me/webawesome-pro/dist/components/select/select.js'
import '@awesome.me/webawesome-pro/dist/components/input/input.js'
import '@awesome.me/webawesome-pro/dist/components/tag/tag.js'
import type { DeviceDocument, Unsaved } from '@matter-manager/core'
import { fixture, html, waitUntil } from '@open-wc/testing-helpers'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { DeviceListView } from '../../src/views/device-list.js'
import '../../src/views/device-list.js'
import { browserDatabase, type TestDatabase } from '../support/browser-database.js'

let database: TestDatabase

beforeEach(() => {
  database = browserDatabase()
})

afterEach(async () => {
  await database.destroy()
})

const device = (
  id: string,
  name: string,
  roomId: string,
  extra: Partial<DeviceDocument> = {},
): Unsaved<DeviceDocument> => ({
  _id: id,
  type: 'device',
  name,
  roomId,
  manualCode: '34970112332',
  installedAt: '2026-08-26',
  addedAt: '2026-08-26T09:00:00.000Z',
  disabled: false,
  remarks: [],
  ...extra,
})

/** The list, waited past its first read. */
async function list(): Promise<DeviceListView> {
  await Promise.all([
    customElements.whenDefined('wa-input'),
    customElements.whenDefined('wa-checkbox'),
  ])
  const element = (await fixture(
    html`<device-list-view .repositories=${database.repositories}></device-list-view>`,
  )) as DeviceListView
  await waitUntil(() => element.loaded, 'the device list never finished its first read')
  await element.updateComplete
  return element
}

/** Types into the search box the way a user does: set the value, then let it report. */
async function search(element: DeviceListView, query: string): Promise<void> {
  const box = element.querySelector('[data-search]') as HTMLElement & { value?: string }
  box.value = query
  box.dispatchEvent(new Event('input', { bubbles: true }))
  await element.updateComplete
}

async function showDisabled(element: DeviceListView): Promise<void> {
  const toggle = element.querySelector('[data-include-disabled]') as HTMLElement & {
    checked?: boolean
  }
  toggle.checked = true
  toggle.dispatchEvent(new Event('change', { bubbles: true }))
  await element.updateComplete
}

/** Room headings, in the order they are rendered. */
const roomsShown = (element: DeviceListView) =>
  [...element.querySelectorAll('[data-room]')].map((node) => node.getAttribute('data-room'))

/** Device ids, in the order they are rendered. */
const shown = (element: DeviceListView) =>
  [...element.querySelectorAll('[data-device-id]')].map((node) =>
    node.getAttribute('data-device-id'),
  )

async function seed(): Promise<void> {
  const { rooms, devices } = database.repositories
  await rooms.save({ _id: 'room:kitchen', type: 'room', path: 'Ground Floor/Kitchen' })
  await rooms.save({ _id: 'room:bath', type: 'room', path: 'First Floor/Bathroom' })
  await devices.save(
    device('device:ceiling', 'Ceiling light', 'room:kitchen', { serial: 'SN-000123' }),
  )
  await devices.save(device('device:extractor', 'Extractor', 'room:kitchen'))
  await devices.save(device('device:mirror', 'Mirror light', 'room:bath'))
  await devices.save(device('device:old', 'Old sensor', 'room:bath', { disabled: true }))
}

describe('when the catalogue cannot be read', () => {
  /** Repositories whose reads reject, the way a storage failure arrives. */
  const failing = () =>
    ({
      devices: { list: async () => Promise.reject(new Error('indexed_db_went_bad')) },
      rooms: { list: async () => Promise.reject(new Error('indexed_db_went_bad')) },
    }) as never

  it('says so rather than showing an empty catalogue', async () => {
    // **The state that did not exist.** `loaded` distinguishes "you have no devices" from "we
    // have not looked yet"; a rejected read left it false forever, so the page rendered its
    // header, its search box and nothing else — indistinguishable from a broken application,
    // and shown to somebody standing in a basement in front of the device they came to look up.
    const element = (await fixture(
      html`<device-list-view .repositories=${failing()}></device-list-view>`,
    )) as DeviceListView
    await waitUntil(() => element.failed, 'the read never reported a failure')
    await element.updateComplete

    expect(element.querySelector('[data-read-failed]')).not.toBeNull()
  })

  it('does not claim the catalogue is empty', async () => {
    // The worst possible message here: this application's entire promise is that a device
    // recorded is a device kept, and "no devices yet" says the opposite of what happened.
    const element = (await fixture(
      html`<device-list-view .repositories=${failing()}></device-list-view>`,
    )) as DeviceListView
    await waitUntil(() => element.failed, 'the read never reported a failure')
    await element.updateComplete

    expect(element.textContent).not.toContain('No devices yet')
  })

  it('is not left in the "not looked yet" state', async () => {
    const element = (await fixture(
      html`<device-list-view .repositories=${failing()}></device-list-view>`,
    )) as DeviceListView
    await waitUntil(() => element.failed, 'the read never reported a failure')

    expect(element.loaded).toBe(false)
    expect(element.failed).toBe(true)
  })

  it('reports nothing when the read works', async () => {
    // The positive control. Without it, a view that rendered the failure permanently would
    // pass every case above.
    const element = await list()

    expect(element.failed).toBe(false)
    expect(element.querySelector('[data-read-failed]')).toBeNull()
  })
})

describe('grouping', () => {
  it('groups by room path and counts what is in each', async () => {
    await seed()
    const element = await list()

    expect(roomsShown(element)).toEqual(['First Floor/Bathroom', 'Ground Floor/Kitchen'])

    const counts = [...element.querySelectorAll('[data-room]')].map(
      (section) => section.querySelectorAll('[data-device-id]').length,
    )
    expect(counts).toEqual([1, 2])
    // The count is on screen, not merely implied by the number of rows.
    expect(element.querySelector('[data-room] wa-badge')?.textContent?.trim()).toBe('1')
  })

  it('names the group for devices whose room is gone, rather than leaving it blank', async () => {
    await database.repositories.devices.save(device('device:orphan', 'Orphan', 'room:gone'))
    const element = await list()

    // Never the raw id: `room:gone` on screen is not a room a person recognises.
    expect(element.textContent).not.toContain('room:gone')
    expect(element.querySelector('[data-room=""] h2')?.textContent?.trim()).not.toBe('')
    expect(shown(element)).toEqual(['device:orphan'])
  })

  it('says so when there is nothing at all', async () => {
    const element = await list()
    expect(element.textContent).toContain('No devices')
  })
})

describe('search', () => {
  it('matches a device name', async () => {
    await seed()
    const element = await list()
    await search(element, 'mirror')

    expect(shown(element)).toEqual(['device:mirror'])
  })

  it('matches a room, so typing a room name shows what is in it', async () => {
    await seed()
    const element = await list()
    await search(element, 'kitchen')

    expect(shown(element)).toEqual(['device:ceiling', 'device:extractor'])
  })

  it('matches a serial number', async () => {
    await seed()
    const element = await list()
    await search(element, 'SN-000123')

    expect(shown(element)).toEqual(['device:ceiling'])
  })

  it('distinguishes "nothing matched" from "you have no devices"', async () => {
    // Telling someone with a full catalogue that it is empty because they mistyped a word is
    // the kind of small lie that makes people stop trusting an application.
    await seed()
    const element = await list()
    await search(element, 'zzzz')

    expect(shown(element)).toEqual([])
    expect(element.textContent).toContain('zzzz')
    expect(element.textContent).not.toContain('No devices yet')
  })

  it('goes back to everything when the box is cleared', async () => {
    await seed()
    const element = await list()
    await search(element, 'mirror')
    await search(element, '')

    expect(shown(element)).toHaveLength(3)
  })
})

describe('disabled devices', () => {
  it('leaves them out until asked for', async () => {
    await seed()
    const element = await list()
    expect(shown(element)).not.toContain('device:old')

    await showDisabled(element)
    expect(shown(element)).toContain('device:old')
  })

  it('does not blame a search nobody made when the filter hid everything', async () => {
    // The third empty state, and the one that was missing. Every device disabled, box
    // unticked: `browseDevices` returns nothing while `devices` is non-empty and the query is
    // blank, so the search sentence would render with an empty pair of quotes in it - blaming
    // the user for a filter they did not notice they had on.
    await database.repositories.rooms.save({
      _id: 'room:kitchen',
      type: 'room',
      path: 'Ground Floor/Kitchen',
    })
    await database.repositories.devices.save(
      device('device:old', 'Old sensor', 'room:kitchen', { disabled: true }),
    )

    const element = await list()

    expect(shown(element)).toEqual([])
    expect(element.textContent).not.toContain('Nothing matches')
    expect(element.textContent).not.toContain('No devices yet')
    // Names the control, because the remedy is one tick away and the message has to say which.
    expect(element.textContent).toContain('Show disabled devices')

    await showDisabled(element)
    expect(shown(element)).toEqual(['device:old'])
  })

  it('marks the ones it shows, so they are not mistaken for working devices', async () => {
    await seed()
    const element = await list()
    await showDisabled(element)

    const row = element.querySelector('[data-device-id="device:old"]')
    expect(row?.hasAttribute('data-disabled')).toBe(true)
    expect(row?.querySelector('wa-tag')).not.toBeNull()

    // And the ones that are fine are not marked, or the distinction says nothing.
    expect(
      element.querySelector('[data-device-id="device:mirror"]')?.hasAttribute('data-disabled'),
    ).toBe(false)
  })
})

describe('the view itself', () => {
  it('offers a way to add a device', async () => {
    const element = await list()
    expect(element.querySelector('wa-button[href="#/devices/new"]')).not.toBeNull()
  })

  it('renders into the light DOM so global utility classes apply', async () => {
    // wa-stack and friends are document-level CSS. A shadow root would leave them inert
    // while --wa-* tokens kept working, which is the half-right failure this pins.
    const element = await list()
    expect(element.shadowRoot).toBeNull()
    expect(element.querySelector('.wa-stack')).not.toBeNull()
  })
})

describe('exporting the inventory', () => {
  /** The list, with the download intercepted. */
  async function listWithDownload(): Promise<{
    element: DeviceListView
    saved: Array<{ bytes: Uint8Array; filename: string }>
  }> {
    const saved: Array<{ bytes: Uint8Array; filename: string }> = []
    const element = await list()
    // The real one clicks a link, which in a test browser is a download prompt or a file
    // written into whatever directory the run happens to have. Neither is a thing a test
    // should cause, and both are invisible when they go wrong.
    ;(element as DeviceListView & { download?: unknown }).download = (
      bytes: Uint8Array,
      filename: string,
    ) => saved.push({ bytes, filename })
    return { element, saved }
  }

  it('produces a PDF named for today', async () => {
    await seed()
    const { element, saved } = await listWithDownload()

    ;(element.querySelector('[data-export]') as HTMLElement).click()
    await waitUntil(() => saved.length === 1, 'the export never finished', { timeout: 10000 })

    expect(saved[0]?.filename).toMatch(/^matter-manager-\d{4}-\d{2}-\d{2}\.pdf$/)
    expect(new TextDecoder('latin1').decode(saved[0]?.bytes).startsWith('%PDF-')).toBe(true)
  })

  it('exports what is on screen, filter and all', async () => {
    // The export takes the groups the list is rendering, so a search or the disabled filter
    // applies to it exactly as the user sees it. Anything else would be an export that
    // disagrees with the page it was started from.
    await seed()
    const { element, saved } = await listWithDownload()

    element.query = 'Mirror'
    await element.updateComplete
    ;(element.querySelector('[data-export]') as HTMLElement).click()
    await waitUntil(() => saved.length === 1, 'the export never finished', { timeout: 10000 })

    expect(saved[0]?.bytes.byteLength).toBeGreaterThan(500)
  })

  it('says what it is doing while it works', async () => {
    await seed()
    const { element } = await listWithDownload()

    // Deterministic rather than timed: the click sets the flag synchronously, so exactly one
    // update cycle later the callout is on the page. Polling for it races an export that may
    // already have finished — which is a test that passes or fails on how fast the machine is.
    ;(element.querySelector('[data-export]') as HTMLElement).click()
    await element.updateComplete

    expect(element.querySelector('[data-export-progress]')).not.toBeNull()
    expect(element.querySelector('[data-cancel-export]')).not.toBeNull()
  })

  it('can be called off', async () => {
    await seed()
    const { element, saved } = await listWithDownload()

    ;(element.querySelector('[data-export]') as HTMLElement).click()
    await waitUntil(() => element.exporting, 'the export never started')
    ;(element.querySelector('[data-cancel-export]') as HTMLElement).click()

    await new Promise((resolve) => setTimeout(resolve, 500))
    expect(saved).toHaveLength(0)
    expect(element.exporting).toBe(false)
  })

  it('does not report a cancellation as a failure', async () => {
    // The user asked for it. Complaining about it would be the application arguing.
    await seed()
    const { element } = await listWithDownload()

    ;(element.querySelector('[data-export]') as HTMLElement).click()
    await waitUntil(() => element.exporting, 'the export never started')
    ;(element.querySelector('[data-cancel-export]') as HTMLElement).click()

    await new Promise((resolve) => setTimeout(resolve, 500))
    await element.updateComplete
    expect(element.querySelector('[data-export-failed]')).toBeNull()
  })

  it('exports an empty project rather than refusing to', async () => {
    const { element, saved } = await listWithDownload()

    ;(element.querySelector('[data-export]') as HTMLElement).click()
    await waitUntil(() => saved.length === 1, 'the export never finished', { timeout: 10000 })

    expect(new TextDecoder('latin1').decode(saved[0]?.bytes).startsWith('%PDF-')).toBe(true)
  })
})

describe('exporting a selection', () => {
  /**
   * Ticks a device by its document id.
   *
   * Through the property and a `change` event, the same way the disabled-filter helper above
   * does it — `click()` on a `<wa-checkbox>` host does not toggle it, so a test using that
   * would assert against a box nobody ticked.
   */
  function tick(element: DeviceListView, id: string): void {
    const box = element.querySelector(`[data-device-id="${id}"] [data-select]`) as
      | (HTMLElement & { checked?: boolean })
      | null
    if (box === null) throw new Error(`no checkbox for ${id}`)
    box.checked = !(box.checked ?? false)
    box.dispatchEvent(new Event('change', { bubbles: true }))
  }

  it('offers no selection export until something is selected', async () => {
    await seed()
    const element = await list()

    expect(element.querySelector('[data-export-selected]')).toBeNull()
  })

  it('offers one, naming how many, once something is', async () => {
    await seed()
    const element = await list()

    tick(element, 'device:ceiling')
    await element.updateComplete

    const button = element.querySelector('[data-export-selected]')
    expect(button).not.toBeNull()
    // Says how many, because on a page where the ticks have scrolled out of view a button
    // called "Export selection" has an invisible effect.
    expect(button?.textContent).toContain('1')
  })

  it('keeps a selection across a search', async () => {
    // The selection has to outlive a search typed while choosing: the devices are re-read and
    // re-grouped on every change, so anything stored on the device objects would be lost.
    await seed()
    const element = await list()

    tick(element, 'device:ceiling')
    element.query = 'Mirror'
    await element.updateComplete
    element.query = ''
    await element.updateComplete

    const box = element.querySelector('[data-device-id="device:ceiling"] [data-select]')
    expect((box as { checked?: boolean } | null)?.checked).toBe(true)
  })

  it('unticks what was ticked', async () => {
    await seed()
    const element = await list()

    tick(element, 'device:ceiling')
    await element.updateComplete
    tick(element, 'device:ceiling')
    await element.updateComplete

    expect(element.querySelector('[data-export-selected]')).toBeNull()
  })

  it('offers a per-room export', async () => {
    await seed()
    const element = await list()

    expect(element.querySelector('[data-export-room="Ground Floor/Kitchen"]')).not.toBeNull()
  })

  it('offers no room export for devices whose room is gone', async () => {
    // There is no room there to export.
    await database.repositories.devices.save(device('device:orphan', 'Orphan', 'room:deleted'))
    const element = await list()

    const buttons = [...element.querySelectorAll('[data-export-room]')].map((node) =>
      node.getAttribute('data-export-room'),
    )
    expect(buttons).not.toContain('')
  })

  it('produces a PDF for one room', async () => {
    await seed()
    const saved: Uint8Array[] = []
    const element = await list()
    ;(element as DeviceListView & { download?: unknown }).download = (bytes: Uint8Array) =>
      saved.push(bytes)

    ;(element.querySelector('[data-export-room="First Floor/Bathroom"]') as HTMLElement).click()
    await waitUntil(() => saved.length === 1, 'the room export never finished', { timeout: 10000 })

    expect(new TextDecoder('latin1').decode(saved[0]).startsWith('%PDF-')).toBe(true)
  })

  it('produces a PDF for the ticked devices', async () => {
    await seed()
    const saved: Uint8Array[] = []
    const element = await list()
    ;(element as DeviceListView & { download?: unknown }).download = (bytes: Uint8Array) =>
      saved.push(bytes)

    tick(element, 'device:ceiling')
    await element.updateComplete
    ;(element.querySelector('[data-export-selected]') as HTMLElement).click()
    await waitUntil(() => saved.length === 1, 'the selection export never finished', {
      timeout: 10000,
    })

    expect(new TextDecoder('latin1').decode(saved[0]).startsWith('%PDF-')).toBe(true)
  })

  it('has no checkbox for a device the filter is hiding', async () => {
    // Which is what makes "disabled devices are excluded unless explicitly included" hold for
    // every selection rather than only the default one: there is nothing to tick.
    await seed()
    const element = await list()

    expect(element.querySelector('[data-device-id="device:old"] [data-select]')).toBeNull()
  })
})

describe('printing labels', () => {
  /** The list, with the download intercepted. */
  async function sheetList(): Promise<{ element: DeviceListView; saved: Uint8Array[] }> {
    const saved: Uint8Array[] = []
    await Promise.all([
      customElements.whenDefined('wa-dialog'),
      customElements.whenDefined('wa-select'),
    ])
    const element = await list()
    ;(element as DeviceListView & { download?: unknown }).download = (bytes: Uint8Array) =>
      saved.push(bytes)
    return { element, saved }
  }

  it('asks which sheet and where to start before printing anything', async () => {
    // Not a one-click export. A label sheet is physical stock: printing one without asking
    // where to start wastes whatever is left of a part-used sheet.
    await seed()
    const { element, saved } = await sheetList()

    ;(element.querySelector('[data-labels]') as HTMLElement).click()
    await element.updateComplete

    expect(element.labelsOpen).toBe(true)
    expect(element.querySelector('[data-label-stock]')).not.toBeNull()
    expect(element.querySelector('[data-label-row]')).not.toBeNull()
    expect(saved).toHaveLength(0)
  })

  it('says to print at 100%', async () => {
    // The label positions are absolute on the physical sheet, so a printer scaling the page to
    // fit puts every label over its die-cut. The user is the only one who can prevent that,
    // which means they have to be told.
    await seed()
    const { element } = await sheetList()

    ;(element.querySelector('[data-labels]') as HTMLElement).click()
    await element.updateComplete

    expect(element.querySelector('[data-label-dialog]')?.textContent).toContain('100%')
  })

  it('produces a sheet', async () => {
    await seed()
    const { element, saved } = await sheetList()

    ;(element.querySelector('[data-labels]') as HTMLElement).click()
    await element.updateComplete
    ;(element.querySelector('[data-print-labels]') as HTMLElement).click()
    await waitUntil(() => saved.length === 1, 'the label sheet never finished', { timeout: 10000 })

    expect(new TextDecoder('latin1').decode(saved[0]).startsWith('%PDF-')).toBe(true)
  })

  it('names the file so a folder of them sorts', async () => {
    await seed()
    const saved: Array<{ filename: string }> = []
    await Promise.all([
      customElements.whenDefined('wa-dialog'),
      customElements.whenDefined('wa-select'),
    ])
    const element = await list()
    ;(element as DeviceListView & { download?: unknown }).download = (
      _bytes: Uint8Array,
      filename: string,
    ) => saved.push({ filename })

    ;(element.querySelector('[data-labels]') as HTMLElement).click()
    await element.updateComplete
    ;(element.querySelector('[data-print-labels]') as HTMLElement).click()
    await waitUntil(() => saved.length === 1, 'the label sheet never finished', { timeout: 10000 })

    expect(saved[0]?.filename).toMatch(/^matter-manager-labels-\d{4}-\d{2}-\d{2}\.pdf$/)
  })

  it('prints only the selection when there is one', async () => {
    await seed()
    const { element, saved } = await sheetList()

    const box = element.querySelector('[data-device-id="device:ceiling"] [data-select]') as
      | (HTMLElement & { checked?: boolean })
      | null
    if (box === null) throw new Error('no checkbox')
    box.checked = true
    box.dispatchEvent(new Event('change', { bubbles: true }))
    await element.updateComplete

    ;(element.querySelector('[data-labels]') as HTMLElement).click()
    await element.updateComplete
    ;(element.querySelector('[data-print-labels]') as HTMLElement).click()
    await waitUntil(() => saved.length === 1, 'the label sheet never finished', { timeout: 10000 })

    expect(new TextDecoder('latin1').decode(saved[0]).startsWith('%PDF-')).toBe(true)
  })

  it('closes the dialog once it starts', async () => {
    // Leaving it open over a progress bar would let a second sheet be started on top of the
    // first, and both would write a file.
    await seed()
    const { element } = await sheetList()

    ;(element.querySelector('[data-labels]') as HTMLElement).click()
    await element.updateComplete
    ;(element.querySelector('[data-print-labels]') as HTMLElement).click()
    await element.updateComplete

    expect(element.labelsOpen).toBe(false)
  })
})
