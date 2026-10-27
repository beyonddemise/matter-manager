import '@awesome.me/webawesome-pro/dist/components/badge/badge.js'
import '@awesome.me/webawesome-pro/dist/components/button/button.js'
import '@awesome.me/webawesome-pro/dist/components/checkbox/checkbox.js'
import '@awesome.me/webawesome-pro/dist/components/callout/callout.js'
import '@awesome.me/webawesome-pro/dist/components/icon/icon.js'
import '@awesome.me/webawesome-pro/dist/components/input/input.js'
import { fixture, html, waitUntil } from '@open-wc/testing-helpers'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { readZip, type ZipLimits } from '../../../src/domain/archive/zip.js'
import type { DeviceDocument, Unsaved } from '../../../src/domain/index.js'
import { streamCodecs } from '../../../src/ui/archive/codec.js'
import { PROJECT_CHANGED } from '../../../src/ui/current-project.js'
import { activateLocale } from '../../../src/ui/i18n/localization.js'
import type { DeviceListView } from '../../../src/ui/views/device-list.js'
import '../../../src/ui/views/device-list.js'
import { browserDatabase, type TestDatabase } from '../support/browser-database.js'

/**
 * The Excel export (#295): the button beside the PDF export, the workbook it downloads, and
 * the German headers. The xlsx is read back with the application's own zip reader and the
 * browser's `DecompressionStream` — the file format itself is pinned by
 * `test/domain/xlsx/workbook.test.ts` against Node's independent zlib.
 */

let database: TestDatabase

beforeEach(() => {
  database = browserDatabase()
})

afterEach(async () => {
  await activateLocale('en')
  await database.destroy()
})

const device = (
  id: string,
  name: string,
  room: string,
  extra: Partial<DeviceDocument> = {},
): Unsaved<DeviceDocument> => ({
  _id: id,
  type: 'device',
  name,
  room,
  manualCode: '34970112332',
  installedAt: '2026-08-26',
  addedAt: '2026-08-26T09:00:00.000Z',
  disabled: false,
  remarks: [],
  ...extra,
})

async function seed(): Promise<void> {
  const { devices } = database.repositories
  // One device with a catalogue match, serial and payload; one bare, filed from a typed code.
  await devices.save(
    device('device:ceiling', 'Ceiling light', 'Ground Floor/Kitchen', {
      serial: 'SN-000123',
      vendorPreferredName: 'Philips Hue',
      productName: 'Hue A19',
      deviceTypeId: 0x010d,
      payload: 'MT:Y.K9042C00KA0648G00',
    }),
  )
  await devices.save(device('device:mirror', 'Mirror light', 'Attic/Studio'))
}

/** The list, waited past its first read, with the download intercepted. */
async function listWithDownload(): Promise<{
  element: DeviceListView
  saved: Array<{ bytes: Uint8Array; filename: string }>
}> {
  await Promise.all([
    customElements.whenDefined('wa-input'),
    customElements.whenDefined('wa-checkbox'),
  ])
  const element = (await fixture(
    html`<device-list-view .repositories=${database.repositories}></device-list-view>`,
  )) as DeviceListView
  await waitUntil(() => element.loaded, 'the device list never finished its first read')
  await element.updateComplete

  const saved: Array<{ bytes: Uint8Array; filename: string }> = []
  ;(element as DeviceListView & { download?: unknown }).download = (
    bytes: Uint8Array,
    filename: string,
  ) => saved.push({ bytes, filename })
  return { element, saved }
}

const LIMITS: ZipLimits = { maxBytes: 10_000_000, maxInflatedBytes: 10_000_000, maxEntries: 100 }

/** The workbook's one sheet, as XML text. */
async function sheetOf(bytes: Uint8Array): Promise<string> {
  const entries = await readZip(bytes, streamCodecs, LIMITS)
  const sheet = entries.find((entry) => entry.name === 'xl/worksheets/sheet1.xml')
  return new TextDecoder().decode(sheet?.data ?? new Uint8Array())
}

/** Every `<t>` text in the sheet, in document order — cells as a reader meets them. */
const texts = (sheet: string): string[] =>
  [...sheet.matchAll(/<t(?:\s[^>]*)?>([^<]*)<\/t>/g)].map((match) => match[1] ?? '')

describe('exporting the inventory to Excel', () => {
  it('downloads an xlsx named for today', async () => {
    await seed()
    const { element, saved } = await listWithDownload()

    ;(element.querySelector('[data-export-xlsx]') as HTMLElement).click()
    await waitUntil(() => saved.length === 1, 'the export never finished', { timeout: 10000 })

    expect(saved[0]?.filename).toMatch(/^matter-manager-\d{4}-\d{2}-\d{2}\.xlsx$/)
    // A zip's magic bytes: what tells the operating system this is a real file, not HTML.
    expect([...(saved[0]?.bytes.slice(0, 2) ?? [])]).toEqual([0x50, 0x4b])
  })

  it('writes one row per device, sorted by room path then name, with the device facts', async () => {
    await seed()
    const { element, saved } = await listWithDownload()

    ;(element.querySelector('[data-export-xlsx]') as HTMLElement).click()
    await waitUntil(() => saved.length === 1, 'the export never finished', { timeout: 10000 })

    const sheet = await sheetOf(saved[0]?.bytes ?? new Uint8Array())
    // Header and two devices — and Attic/Studio sorts before Ground Floor/Kitchen.
    expect([...sheet.matchAll(/<row /g)]).toHaveLength(3)
    const cells = texts(sheet)
    expect(cells.indexOf('Mirror light')).toBeLessThan(cells.indexOf('Ceiling light'))
    for (const value of [
      'Ground Floor/Kitchen',
      'Philips Hue',
      'Hue A19',
      'SN-000123',
      '0x010D',
      '34970112332',
      'MT:Y.K9042C00KA0648G00',
      '2026-08-26',
    ]) {
      expect(cells).toContain(value)
    }
  })

  it('exports a device without a catalogue match or serial as empty cells, not an error', async () => {
    await seed()
    const { element, saved } = await listWithDownload()

    ;(element.querySelector('[data-export-xlsx]') as HTMLElement).click()
    await waitUntil(() => saved.length === 1, 'the export never finished', { timeout: 10000 })

    const sheet = await sheetOf(saved[0]?.bytes ?? new Uint8Array())
    // The bare device's row holds exactly its five facts; the five unknown columns are
    // absent cells rather than placeholders or a refused export.
    const mirrorRow = /<row [^>]*>(?:(?!<\/row>).)*Mirror light.*?<\/row>/s.exec(sheet)?.[0] ?? ''
    expect(texts(mirrorRow)).toEqual(['Attic/Studio', 'Mirror light', '2026-08-26', '34970112332'])
  })

  it('exports what is on screen, filter and all', async () => {
    await seed()
    const { element, saved } = await listWithDownload()

    element.query = 'Mirror'
    await element.updateComplete
    ;(element.querySelector('[data-export-xlsx]') as HTMLElement).click()
    await waitUntil(() => saved.length === 1, 'the export never finished', { timeout: 10000 })

    const sheet = await sheetOf(saved[0]?.bytes ?? new Uint8Array())
    expect(texts(sheet)).toContain('Mirror light')
    expect(texts(sheet)).not.toContain('Ceiling light')
  })

  it('abandons an export the moment the reader moves to another project', async () => {
    // Security, not tidiness: the workbook under construction holds the pairing codes of the
    // project it was started from. Finished after the switch, it would be downloaded under
    // the new project's view. The dispatch lands synchronously after the click, before the
    // builder's first microtask, so the export is reliably still pending.
    await seed()
    const { element, saved } = await listWithDownload()

    ;(element.querySelector('[data-export-xlsx]') as HTMLElement).click()
    window.dispatchEvent(new CustomEvent(PROJECT_CHANGED))

    // The switch also means the new project has not been read yet.
    expect(element.loaded).toBe(false)

    await new Promise((resolve) => setTimeout(resolve, 500))
    expect(saved).toHaveLength(0)
    expect(element.exporting).toBe(false)
  })

  it('is not offered before the first read has succeeded', async () => {
    // Before the read there is nothing to export, and a header-only workbook handed to a
    // client reads as an empty building. The handler refuses as well as the button, because
    // a programmatic click does not honour `disabled`.
    const pending = { devices: { list: () => new Promise(() => {}) } } as never
    const element = (await fixture(
      html`<device-list-view .repositories=${pending}></device-list-view>`,
    )) as DeviceListView
    await element.updateComplete
    const saved: unknown[] = []
    ;(element as DeviceListView & { download?: unknown }).download = (bytes: Uint8Array) =>
      saved.push(bytes)

    const button = element.querySelector('[data-export-xlsx]') as HTMLElement
    expect(button.hasAttribute('disabled')).toBe(true)
    button.click()

    await new Promise((resolve) => setTimeout(resolve, 300))
    expect(saved).toHaveLength(0)
  })

  it('writes German headers under the German locale', async () => {
    await seed()
    await activateLocale('de')
    const { element, saved } = await listWithDownload()

    ;(element.querySelector('[data-export-xlsx]') as HTMLElement).click()
    await waitUntil(() => saved.length === 1, 'the export never finished', { timeout: 10000 })

    const sheet = await sheetOf(saved[0]?.bytes ?? new Uint8Array())
    const header = texts(/<row [^>]*>.*?<\/row>/s.exec(sheet)?.[0] ?? '')
    for (const expected of ['Raum', 'Hersteller', 'Seriennummer', 'Kopplungscode']) {
      expect(header).toContain(expected)
    }
    expect(header).not.toContain('Room')
  })
})
