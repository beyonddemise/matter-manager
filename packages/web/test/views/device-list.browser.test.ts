import '@awesome.me/webawesome-pro/dist/components/badge/badge.js'
import '@awesome.me/webawesome-pro/dist/components/button/button.js'
import '@awesome.me/webawesome-pro/dist/components/checkbox/checkbox.js'
import '@awesome.me/webawesome-pro/dist/components/icon/icon.js'
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
