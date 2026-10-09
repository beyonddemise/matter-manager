import { PDFDocument, StandardFonts } from 'pdf-lib'
import { describe, expect, it } from 'vitest'
import {
  A4,
  browseDevices,
  type DeviceDocument,
  entriesOf,
  layoutInventory,
  type RoomDocument,
} from '../../../src/domain/index.js'
import {
  buildInventoryPdf,
  ExportCancelled,
  type InventoryLabels,
  QR_SIZE,
} from '../../../src/ui/pdf/inventory.js'
import { extractPlacedText, extractText } from './text-extraction.js'

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

  // Ruling R27: the device page shows the manufacturer whenever it is known, so the paper does.
  it('prints the manufacturer beside the hex product id when the model is unknown', async () => {
    const bytes = await buildInventoryPdf(
      groupsFor([
        device({ name: 'Found vendor', vendorName: 'Aqara', vendorPreferredName: 'Aqara Home' }),
        device({ name: 'Test vendor device', vendorName: 'Test vendor' }),
      ]),
      { labels: LABELS },
    )
    const text = (await extractText(bytes)).join('\n')
    expect(text).toContain('Aqara Home / 0x8000')
    expect(text).toContain('Test vendor / 0x8000')
    expect(text).not.toContain('0xFFF1')
  })

  it('prints the manufacturer alone when no product id is known either', async () => {
    const { productId: _productId, ...noProduct } = device({ vendorName: 'Aqara' })
    const bytes = await buildInventoryPdf(groupsFor([noProduct]), { labels: LABELS })
    const text = (await extractText(bytes)).join('\n')
    expect(text.split('\n')).toContain('Aqara')
  })
})

/**
 * Ruling R28: `A4.entryHeight` (116pt) is a fixed budget, set before the catalogue added two
 * lines (product with manufacturer, part number). This pins that a full entry, with the longest
 * realistic names, draws every line once (no wrap) and inside its own box, with a visible gap
 * before the next entry, and that the QR code beside it does too.
 */
describe('a full catalogue entry fits its height', () => {
  /** Helvetica's ascender and descender, as fractions of the size (the AFM's 718 and -207). */
  const ASCENT = 0.718
  const DESCENT = 0.207
  /** The least white space left between one entry's content and the next entry. */
  const GAP = 8
  /** Where the text column starts: the margin, the QR code, and the 16pt gap. */
  const TEXT_LEFT = A4.margin + QR_SIZE + 16
  /** Name, product, part number, installed, spot, serial, pairing code. */
  const LINES_PER_ENTRY = 7

  const rooms: RoomDocument[] = [
    {
      _id: 'room:guest',
      _rev: '1-a',
      updatedAt: '2026-08-19T08:00:00.000Z',
      type: 'room',
      path: 'First Floor/Guest Bedroom/Wardrobe Corner by the Window',
    },
  ]

  const full = (name: string, extra: Partial<DeviceDocument>): DeviceDocument =>
    device({
      name,
      roomId: 'room:guest',
      spot: 'behind the wardrobe in the guest bedroom, top left corner',
      serial: 'SN-0123456789ABCDEF',
      partNumber: 'LCA001 / 9290022166',
      ...extra,
    })

  const devices = [
    full('Hallway door contact, front entrance', {
      vendorName: 'Lumi United Technology Co., Ltd',
      vendorPreferredName: 'Aqara',
      productName: 'Aqara Door and Window Sensor P2',
    }),
    full('Guest bedroom ceiling light, wardrobe side', {
      vendorName: 'Signify Netherlands B.V.',
      vendorPreferredName: 'Signify Netherlands B.V.',
      productName: 'Philips Hue White and Color Ambiance A19 E26 Smart Bulb',
    }),
  ]

  it('leaves room for the QR code and a gap', () => {
    expect(QR_SIZE + GAP).toBeLessThanOrEqual(A4.entryHeight)
  })

  it('draws two full entries without a wrapped line, each inside its own box', async () => {
    const groups = browseDevices(devices, rooms, { includeDisabled: false })
    const bytes = await buildInventoryPdf(groups, { labels: LABELS })
    const [page] = layoutInventory(groups, A4)
    const tops = entriesOf(page ?? { number: 1, blocks: [] }).map((entry) => entry.top)
    expect(tops).toHaveLength(2)

    /** The layout counts down from the top of the usable area; PDF counts up from the foot. */
    const fromTop = (y: number) => A4.height - A4.margin - y
    const column = (await extractPlacedText(bytes))
      .filter((line) => Math.abs(line.x - TEXT_LEFT) < 0.01)
      .sort((a, b) => b.y - a.y)

    // A wrapped line would add an entry here, and split the expected string in two.
    expect(column).toHaveLength(LINES_PER_ENTRY * 2)
    const texts = column.map((line) => line.text)
    expect(texts).toContain('Aqara Aqara Door and Window Sensor P2')
    expect(texts).toContain(
      'Signify Netherlands B.V. Philips Hue White and Color Ambiance A19 E26 Smart Bulb',
    )
    expect(texts).toContain('behind the wardrobe in the guest bedroom, top left corner')

    column.forEach((line, index) => {
      const top = tops[Math.floor(index / LINES_PER_ENTRY)] ?? Number.NaN
      expect(fromTop(line.y) - ASCENT * line.size).toBeGreaterThanOrEqual(top)
      expect(fromTop(line.y) + DESCENT * line.size).toBeLessThanOrEqual(top + A4.entryHeight - GAP)
    })
  })
})

/**
 * #238: name, spot and serial are free text with no length limit. Left to `pdf-lib`'s
 * `maxWidth`, a long one wraps at the default 24pt line height and draws over the next line or
 * the next entry. Each is cut to its column on one line, with an ellipsis, instead.
 */
describe('free text longer than its column', () => {
  const TEXT_LEFT = A4.margin + QR_SIZE + 16
  const COLUMN = A4.width - A4.margin - TEXT_LEFT
  /** Name, product, installed, spot, serial, pairing code. */
  const LINES_PER_ENTRY = 6
  const LONG = 'Living room floor lamp beside the reading chair by the bay window '.repeat(4)

  it('truncates each with an ellipsis, on one line that fits the column', async () => {
    const devices = [
      device({ name: `A ${LONG}`, spot: LONG, serial: 'SN-'.padEnd(200, '0123456789') }),
      device({ name: `B ${LONG}`, spot: LONG, serial: 'SN-'.padEnd(200, '0123456789') }),
    ]
    const bytes = await buildInventoryPdf(groupsFor(devices), { labels: LABELS })

    const column = (await extractPlacedText(bytes))
      .filter((line) => Math.abs(line.x - TEXT_LEFT) < 0.01)
      .sort((a, b) => b.y - a.y)

    // A wrapped line would add an entry here.
    expect(column).toHaveLength(LINES_PER_ENTRY * 2)
    const cut = column.filter((line) => line.text.endsWith('…'))
    // Name, spot and serial, in both entries.
    expect(cut).toHaveLength(6)

    const pdf = await PDFDocument.create()
    // The fonts the entry draws in, by size: the 11pt name is bold, the 9pt details are not.
    const fonts = new Map([
      [11, await pdf.embedFont(StandardFonts.HelveticaBold)],
      [9, await pdf.embedFont(StandardFonts.Helvetica)],
    ])
    for (const line of cut) {
      const font = fonts.get(line.size)
      expect(font, `a font for size ${line.size}`).toBeDefined()
      expect(font?.widthOfTextAtSize(line.text, line.size)).toBeLessThanOrEqual(COLUMN)
    }

    // No two lines share a baseline or come closer than the smallest line step.
    column.slice(1).forEach((line, index) => {
      const above = column[index]?.y ?? Number.NaN
      expect(above - line.y).toBeGreaterThanOrEqual(9)
    })
  })
})
