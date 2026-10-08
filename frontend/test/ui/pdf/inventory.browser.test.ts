import { describe, expect, it } from 'vitest'
import { browseDevices, type DeviceDocument, type RoomDocument } from '../../../src/domain/index.js'
import {
  buildInventoryPdf,
  ExportCancelled,
  type InventoryLabels,
} from '../../../src/ui/pdf/inventory.js'
import { extractText } from './text-extraction.js'

/** The verified reference device; see `test/domain/matter/payload.test.ts`. */
const PAYLOAD = 'MT:Y.K9042C00KA0648G00'
const LONG_CODE = '749701123365521327687'

const LABELS: InventoryLabels = {
  title: 'Matter Manager inventory',
  pageNumber: (page, total) => `Page ${page} of ${total}`,
  continued: (path) => `${path} (continued)`,
  installed: 'Installed',
  pairingCode: 'Pairing code',
  partNumber: 'Part number',
  noQrCode: 'No QR code',
  withoutRoom: 'Without a room',
  nothingToExport: 'There is nothing to export.',
}

const device = (extra: Partial<DeviceDocument> = {}): DeviceDocument => ({
  _id: `device:${extra.name ?? 'lamp'}`,
  _rev: '1-a',
  updatedAt: '2026-08-19T08:00:00.000Z',
  type: 'device',
  name: 'Kitchen ceiling light',
  roomId: 'room:kitchen',
  payload: PAYLOAD,
  manualCode: LONG_CODE,
  vendorId: 0xfff1,
  productId: 0x8000,
  installedAt: '2026-08-19',
  addedAt: '2026-08-19T08:00:00.000Z',
  disabled: false,
  remarks: [],
  ...extra,
})

const ROOMS: readonly RoomDocument[] = [
  {
    _id: 'room:kitchen',
    _rev: '1-a',
    updatedAt: '2026-08-19T08:00:00.000Z',
    type: 'room',
    path: 'Ground Floor/Kitchen',
  },
]

const groupsFor = (devices: readonly DeviceDocument[], includeDisabled = false) =>
  browseDevices(devices, ROOMS, { includeDisabled })

/** The PDF as text, for the assertions that are about words rather than pixels. */
function readable(bytes: Uint8Array): string {
  // PDF content streams are compressed, so a raw scan finds only what pdf-lib left
  // uncompressed. That is enough for the structural assertions here; M3-4 extracts text
  // properly, which is the assertion German needs.
  return new TextDecoder('latin1').decode(bytes)
}

describe('exporting an inventory', () => {
  it('produces a PDF', async () => {
    const bytes = await buildInventoryPdf(groupsFor([device()]), { labels: LABELS })

    // The header a PDF reader looks for. A "file" that is not one is a failure a byte-length
    // assertion would miss entirely.
    expect(readable(bytes).startsWith('%PDF-')).toBe(true)
    expect(bytes.byteLength).toBeGreaterThan(1000)
  })

  it('includes every enabled device and leaves out the disabled ones', async () => {
    // Through `browseDevices`, which is what the screen uses. The export and the list cannot
    // disagree about what the project contains, because they ask the same function.
    const devices = [
      device({ name: 'Kitchen ceiling light' }),
      device({ name: 'Old sensor', disabled: true }),
    ]

    const enabled = groupsFor(devices)
    expect(enabled.flatMap((group) => group.devices).map((entry) => entry.name)).toEqual([
      'Kitchen ceiling light',
    ])

    const bytes = await buildInventoryPdf(enabled, { labels: LABELS })
    expect(bytes.byteLength).toBeGreaterThan(1000)
  })

  it('reports progress device by device', async () => {
    const devices = [device({ name: 'One' }), device({ name: 'Two' }), device({ name: 'Three' })]
    const seen: number[] = []

    await buildInventoryPdf(groupsFor(devices), {
      labels: LABELS,
      onProgress: ({ done, total }) => {
        expect(total).toBe(3)
        seen.push(done)
      },
    })

    expect(seen).toEqual([1, 2, 3])
  })

  it('stops when asked to', async () => {
    const devices = [device({ name: 'One' }), device({ name: 'Two' })]

    await expect(
      buildInventoryPdf(groupsFor(devices), { labels: LABELS, cancelled: () => true }),
    ).rejects.toThrow(ExportCancelled)
  })

  it('produces an openable file for a project with nothing in it', async () => {
    // A zero-page PDF does not open. "There is nothing to export" on one page is a worse
    // answer only if the alternative is a file that errors.
    const bytes = await buildInventoryPdf(groupsFor([]), { labels: LABELS })

    expect(readable(bytes).startsWith('%PDF-')).toBe(true)
  })

  it('exports a device that has no payload, without inventing one', async () => {
    const { payload: _payload, ...rest } = device({ name: 'Typed in' })
    const bytes = await buildInventoryPdf(groupsFor([rest as DeviceDocument]), { labels: LABELS })

    expect(readable(bytes).startsWith('%PDF-')).toBe(true)
  })

  it('carries a title and no other metadata', async () => {
    // Metadata is the quiet way documents carry things nobody meant to publish, and this one
    // is handed to other people.
    const text = readable(await buildInventoryPdf(groupsFor([device()]), { labels: LABELS }))

    expect(text).not.toContain('/Author')
    expect(text).not.toContain('/Keywords')
  })
})

describe('what the catalogue knows', () => {
  it('prints the preferred manufacturer name and the part number', async () => {
    const bytes = await buildInventoryPdf(
      groupsFor([
        device({
          vendorName: 'Aqara',
          vendorPreferredName: 'Aqara Home',
          productName: 'Door and Window Sensor P2',
          partNumber: 'AS056',
        }),
      ]),
      { labels: LABELS },
    )
    const text = (await extractText(bytes)).join('\n')
    expect(text).toContain('Aqara Home Door and Window Sensor P2')
    expect(text).toContain('Part number: AS056')
  })
})
