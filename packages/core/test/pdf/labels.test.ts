import { describe, expect, it } from 'vitest'
import type { DeviceDocument } from '../../src/documents/types.js'
import {
  AVERY_5160,
  AVERY_L7160,
  AVERY_L7163,
  FIRST_LABEL,
  LABEL_STOCKS,
  type LabelStock,
  type LabelSubject,
  layoutLabels,
  MM,
} from '../../src/pdf/labels.js'

const device = (name: string): DeviceDocument => ({
  _id: `device:${name}`,
  _rev: '1-a',
  updatedAt: '2026-08-19T08:00:00.000Z',
  type: 'device',
  name,
  roomId: 'room:kitchen',
  manualCode: '34970112332',
  installedAt: '2026-08-19',
  addedAt: '2026-08-19T08:00:00.000Z',
  disabled: false,
  remarks: [],
})

const subjects = (count: number): LabelSubject[] =>
  Array.from({ length: count }, (_, index) => ({
    device: device(`Device ${index}`),
    roomPath: 'Ground Floor/Kitchen',
  }))

/** Millimetres, for assertions written the way the stock is sold. */
const mm = (points: number) => points / MM

describe('the label stocks', () => {
  // Measured from Avery's own templates, not recalled. These assertions are the record of what
  // was measured: if someone changes a constant, the number they have to change here is the
  // number they have to justify.
  it.each([
    [AVERY_L7160, { width: 63.5, height: 38.1, columns: 3, rows: 7, top: 15.15 }],
    [AVERY_L7163, { width: 99.06, height: 38.1, columns: 2, rows: 7, top: 15.15 }],
  ])('describes $code as it is sold', (stock, expected) => {
    expect(mm(stock.labelWidth)).toBeCloseTo(expected.width, 2)
    expect(mm(stock.labelHeight)).toBeCloseTo(expected.height, 2)
    expect(stock.columns).toBe(expected.columns)
    expect(stock.rows).toBe(expected.rows)
    expect(mm(stock.top)).toBeCloseTo(expected.top, 2)
  })

  it.each(LABEL_STOCKS)('fits $code inside its own sheet', (stock: LabelStock) => {
    // The arithmetic the acceptance criterion rests on. A grid that overruns the sheet cannot
    // align with it however carefully the rest is drawn.
    const right = stock.left + (stock.columns - 1) * stock.pitchX + stock.labelWidth
    const bottom = stock.top + (stock.rows - 1) * stock.pitchY + stock.labelHeight

    expect(right).toBeLessThanOrEqual(stock.pageWidth + 0.01)
    expect(bottom).toBeLessThanOrEqual(stock.pageHeight + 0.01)
    expect(stock.left).toBeGreaterThan(0)
    expect(stock.top).toBeGreaterThan(0)
  })

  it.each(LABEL_STOCKS)('leaves no overlap between labels on $code', (stock: LabelStock) => {
    // Pitch below label width would print each label across the die-cut into its neighbour.
    expect(stock.pitchX).toBeGreaterThanOrEqual(stock.labelWidth)
    expect(stock.pitchY).toBeGreaterThanOrEqual(stock.labelHeight)
  })

  it('centres the A4 grids horizontally', () => {
    // Avery's Word template is ~0.18mm right of centre, which is below the sheet's own ±2mm
    // manufacturing tolerance and reads as a twip-rounding artefact. Centring from the
    // verified pitches is what the independent manufacturer specification agrees with.
    for (const stock of [AVERY_L7160, AVERY_L7163]) {
      const right =
        stock.pageWidth - (stock.left + (stock.columns - 1) * stock.pitchX + stock.labelWidth)
      expect(mm(right)).toBeCloseTo(mm(stock.left), 3)
    }
  })

  it('keeps the US stock on US Letter', () => {
    // 5160 is the role equivalent of L7160 and not a geometric one — different page, different
    // label, different count. Sharing a layout between them would be wrong on both.
    expect(mm(AVERY_5160.pageWidth)).toBeCloseTo(215.9, 1)
    expect(mm(AVERY_5160.pageHeight)).toBeCloseTo(279.4, 1)
    expect(AVERY_5160.columns * AVERY_5160.rows).toBe(30)
  })
})

describe('placing labels', () => {
  it('fills a sheet left to right, top to bottom', () => {
    const [page] = layoutLabels(subjects(4), AVERY_L7160)
    const positions = page?.labels.map((label) => [mm(label.x), mm(label.y)]) ?? []

    expect(positions[0]?.[1]).toBeCloseTo(positions[1]?.[1] ?? 0, 5)
    expect(positions[0]?.[0]).toBeLessThan(positions[1]?.[0] ?? 0)
    // The fourth wraps to the second row, back at the left.
    expect(positions[3]?.[0]).toBeCloseTo(positions[0]?.[0] ?? 0, 5)
    expect(positions[3]?.[1]).toBeGreaterThan(positions[0]?.[1] ?? 0)
  })

  it('starts a new sheet when one is full', () => {
    const pages = layoutLabels(subjects(22), AVERY_L7160)

    expect(pages).toHaveLength(2)
    expect(pages[0]?.labels).toHaveLength(21)
    expect(pages[1]?.labels).toHaveLength(1)
  })

  it('prints every device exactly once', () => {
    const pages = layoutLabels(subjects(50), AVERY_L7160)
    const printed = pages.flatMap((page) => page.labels.map((label) => label.device.name))

    expect(printed).toEqual(subjects(50).map((subject) => subject.device.name))
  })

  it('places nothing on a sheet position that is off the sheet', () => {
    // Every placed label has to be inside the page, or the criterion fails on the one label
    // that is not.
    for (const stock of LABEL_STOCKS) {
      for (const page of layoutLabels(subjects(stock.columns * stock.rows), stock)) {
        for (const label of page.labels) {
          expect(label.x).toBeGreaterThanOrEqual(0)
          expect(label.y).toBeGreaterThanOrEqual(0)
          expect(label.x + label.width).toBeLessThanOrEqual(stock.pageWidth + 0.01)
          expect(label.y + label.height).toBeLessThanOrEqual(stock.pageHeight + 0.01)
        }
      }
    }
  })

  it('prints nothing at all rather than a blank sheet', () => {
    // Unlike the inventory, where an empty page saying so beats a file that will not open: a
    // blank label sheet wastes a sheet of adhesive stock.
    expect(layoutLabels([], AVERY_L7160)).toEqual([])
  })
})

describe('starting part-way down a used sheet', () => {
  it('begins at the row and column asked for', () => {
    // Row 2, column 3 of a 3-across sheet is the sixth label.
    const [page] = layoutLabels(subjects(1), AVERY_L7160, { row: 2, column: 3 })
    const label = page?.labels[0]

    expect(mm(label?.x ?? 0)).toBeCloseTo(mm(AVERY_L7160.left + 2 * AVERY_L7160.pitchX), 5)
    expect(mm(label?.y ?? 0)).toBeCloseTo(mm(AVERY_L7160.top + AVERY_L7160.pitchY), 5)
  })

  it('leaves the used labels empty rather than printing over them', () => {
    const [page] = layoutLabels(subjects(3), AVERY_L7160, { row: 1, column: 2 })

    expect(page?.labels).toHaveLength(3)
    expect(mm(page?.labels[0]?.x ?? 0)).toBeCloseTo(mm(AVERY_L7160.left + AVERY_L7160.pitchX), 5)
  })

  it('offsets the run once, not every sheet', () => {
    // The failure this pins: treating the start as a per-sheet offset leaves the same corner
    // blank on every sheet, wasting a label per sheet for the rest of the job.
    const pages = layoutLabels(subjects(41), AVERY_L7160, { row: 1, column: 2 })

    expect(pages[0]?.labels).toHaveLength(20)
    expect(pages[1]?.labels).toHaveLength(21)
  })

  it('fills the whole sheet when told to start at the first label', () => {
    const [page] = layoutLabels(subjects(21), AVERY_L7160, FIRST_LABEL)
    expect(page?.labels).toHaveLength(21)
  })

  it.each([
    ['zero', { row: 0, column: 0 }],
    ['negative', { row: -3, column: -1 }],
    ['past the end of the sheet', { row: 99, column: 99 }],
    ['fractional', { row: 2.7, column: 1.2 }],
    ['not a number', { row: Number.NaN, column: Number.NaN }],
  ])('clamps a start position that is %s rather than refusing', (_case, start) => {
    // It arrives from a number input, where a stray keystroke is far more likely than an
    // intention, and the harm of clamping is one misplaced sheet against an export that will
    // not run at all.
    const pages = layoutLabels(subjects(2), AVERY_L7160, start)

    expect(pages.length).toBeGreaterThan(0)
    for (const page of pages) {
      for (const label of page.labels) {
        expect(label.x + label.width).toBeLessThanOrEqual(AVERY_L7160.pageWidth + 0.01)
        expect(label.y + label.height).toBeLessThanOrEqual(AVERY_L7160.pageHeight + 0.01)
      }
    }
  })
})
