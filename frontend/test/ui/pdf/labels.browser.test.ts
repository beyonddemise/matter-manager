import { PDFDocument, StandardFonts } from 'pdf-lib'
import { describe, expect, it } from 'vitest'
import {
  AVERY_L7160,
  browseDevices,
  type DeviceDocument,
  LABEL_SAFE_INSET,
  MM,
  type RoomDocument,
} from '../../../src/domain/index.js'
import { buildLabelPdf, type LabelOptions } from '../../../src/ui/pdf/labels.js'
import { extractPlacedText } from './text-extraction.js'

/** The verified reference device; see `test/domain/matter/payload.test.ts`. */
const PAYLOAD = 'MT:Y.K9042C00KA0648G00'

const OPTIONS: LabelOptions = {
  stock: AVERY_L7160,
  title: 'Labels',
  noQrCode: 'Filed from a pairing code',
  withoutRoom: 'Without a room',
}

/** The room line's size, in points, as `labels.ts` draws it. */
const DETAIL_SIZE = 7

/** The width a label's text column has, by the same arithmetic `labels.ts` uses. */
function textWidth(): number {
  const width = AVERY_L7160.labelWidth - LABEL_SAFE_INSET * 2
  const height = AVERY_L7160.labelHeight - LABEL_SAFE_INSET * 2
  const qrSize = Math.min(height, AVERY_L7160.labelWidth * 0.4)
  return width - qrSize - 3 * MM
}

const room = (path: string): RoomDocument => ({
  _id: 'room:studio',
  _rev: '1-a',
  updatedAt: '2026-08-19T08:00:00.000Z',
  type: 'room',
  path,
})

const lamp: DeviceDocument = {
  _id: 'device:lamp',
  _rev: '1-a',
  updatedAt: '2026-08-19T08:00:00.000Z',
  type: 'device',
  name: 'Studio lamp',
  roomId: 'room:studio',
  payload: PAYLOAD,
  manualCode: '34970112332',
  installedAt: '2026-08-19',
  addedAt: '2026-08-19T08:00:00.000Z',
  disabled: false,
  remarks: [],
}

/** The room lines of a sheet with one label for `lamp` in a room at `path`. */
async function roomLines(path: string) {
  const bytes = await buildLabelPdf(browseDevices([lamp], [room(path)]), OPTIONS)
  return (await extractPlacedText(bytes)).filter((line) => line.size === DETAIL_SIZE)
}

/**
 * #238: a label names its room as the device list and the inventory do since #242. `Attic/Studio`
 * reads as a file name on a fuse box; `Attic › Studio` reads as a place.
 */
describe('the room on a label', () => {
  it('is printed as a breadcrumb', async () => {
    const texts = (await roomLines('Attic/Studio')).map((line) => line.text)
    expect(texts).toContain('Attic › Studio')
    expect(texts).not.toContain('Attic/Studio')
  })

  it('is cut to the label’s text width, ending in an ellipsis', async () => {
    const path = 'Ground Floor/East Wing/Utility Room/Behind the Washing Machine'
    const [line] = (await roomLines(path)).filter((placed) => placed.text.startsWith('Ground'))
    expect(line?.text.startsWith('Ground Floor › East Wing')).toBe(true)
    expect(line?.text.endsWith('…')).toBe(true)

    const font = await (await PDFDocument.create()).embedFont(StandardFonts.Helvetica)
    expect(font.widthOfTextAtSize(line?.text ?? '', DETAIL_SIZE)).toBeLessThanOrEqual(textWidth())
  })
})
