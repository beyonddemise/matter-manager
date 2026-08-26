import '@awesome.me/webawesome-pro/dist/components/button/button.js'
import '@awesome.me/webawesome-pro/dist/components/icon/icon.js'
import { fixture, html, waitUntil } from '@open-wc/testing-helpers'
import { afterEach, beforeEach, expect, it } from 'vitest'
import type { DeviceListView } from '../src/views/device-list.js'
import '../src/views/device-list.js'
import '../src/views/not-found.js'
import { browserDatabase, type TestDatabase } from './support/browser-database.js'

let database: TestDatabase

beforeEach(() => {
  database = browserDatabase()
})

afterEach(async () => {
  await database.destroy()
})

/** The list with a database of its own, waited past its first read. */
async function list(): Promise<DeviceListView> {
  const element = (await fixture(
    html`<device-list-view .repositories=${database.repositories}></device-list-view>`,
  )) as DeviceListView
  await waitUntil(() => element.loaded, 'the device list never finished its first read')
  return element
}

const device = (id: string, name: string, roomId: string) => ({
  _id: id,
  type: 'device' as const,
  name,
  roomId,
  manualCode: '34970112332',
  installedAt: '2026-08-26',
  addedAt: '2026-08-26T09:00:00.000Z',
  disabled: false,
  remarks: [],
})

it('shows a heading and an empty state on the device list', async () => {
  const element = await list()
  const heading = element.querySelector('h1')

  expect(heading?.textContent?.trim()).not.toBe('')
  expect(element.textContent).toContain('No devices')
})

it('shows the devices that exist, with the room they are in', async () => {
  await database.repositories.rooms.save({
    _id: 'room:kitchen',
    type: 'room',
    path: 'Ground Floor/Kitchen',
  })
  await database.repositories.devices.save(
    device('device:lamp', 'Kitchen ceiling light', 'room:kitchen'),
  )

  const element = await list()
  const entry = element.querySelector('[data-device-id="device:lamp"]')

  expect(entry?.textContent).toContain('Kitchen ceiling light')
  expect(entry?.textContent).toContain('Ground Floor/Kitchen')
  expect(element.textContent).not.toContain('No devices')
})

it('never shows a room id where a room name belongs', async () => {
  // A device whose room was removed still has a `roomId`. Rendering the raw id would put
  // `room:3fa85f64-…` on screen, which is not a room a person can recognise.
  await database.repositories.devices.save(device('device:orphan', 'Orphan', 'room:missing'))

  const element = await list()
  expect(element.textContent).not.toContain('room:missing')
})

it('offers a way to add a device', async () => {
  const element = await list()
  const add = element.querySelector('wa-button[href="#/devices/new"]')
  expect(add).not.toBeNull()
})

it('renders into the light DOM so global utility classes apply', async () => {
  // wa-stack and friends are document-level CSS. A shadow root would leave them inert
  // while --wa-* tokens kept working, which is the half-right failure this pins.
  const element = await list()
  expect(element.shadowRoot).toBeNull()
  expect(element.querySelector('.wa-stack')).not.toBeNull()
})

it('offers a way back from the not-found view', async () => {
  const element = await fixture(html`<not-found-view></not-found-view>`)
  const link = element.querySelector('a')

  // The issue requires a way back, not merely an apology.
  expect(link).not.toBeNull()
  expect(link?.getAttribute('href')).toBe('#/')
})

it('uses a real heading element rather than styled text', async () => {
  const element = await fixture(html`<not-found-view></not-found-view>`)
  expect(element.querySelector('h1')).not.toBeNull()
})
