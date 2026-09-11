/**
 * Laying QR codes out on adhesive label stock.
 *
 * The acceptance criterion here is physical: "label boundaries align with the physical sheet
 * when printed at 100%". That makes every number in this file a measurement rather than a
 * choice, and it is why they are cited. A layout that looks right on screen and is 2mm out on
 * paper produces a sheet of labels each printed across the gap between two of them, and the
 * only way to find out is to waste a sheet.
 *
 * **The dimensions were measured from Avery's own Word and PDF templates**, not recalled and
 * not taken from a blog. Avery publishes label size and count on its product pages but no
 * margin or pitch table; the templates carry the geometry, and each was cross-checked against a
 * label manufacturer's independent specification. Where the two disagree, the disagreement is
 * recorded rather than averaged away.
 *
 * Units are PostScript points, as everywhere else in `pdf/`. The stocks are specified in
 * millimetres because that is how they are sold and measured, and converted once.
 *
 * @module
 */

import type { DeviceDocument } from '../documents/types.js'

/** Millimetres to PostScript points. 72 points to the inch, 25.4 millimetres to the inch. */
export const MM = 72 / 25.4

/**
 * One sheet of labels, in points.
 *
 * Described as **pitch** rather than gap, because pitch is what a position calculation
 * actually uses and deriving it from a gap is one more place to be out by a fraction. Both
 * forms appear in the sources; Avery publishes the redundant set.
 */
export interface LabelStock {
  /** The product code, so a user can match it against the box in their hand. */
  readonly code: string
  readonly pageWidth: number
  readonly pageHeight: number
  readonly columns: number
  readonly rows: number
  readonly labelWidth: number
  readonly labelHeight: number
  /** Left edge of the first column, from the left edge of the sheet. */
  readonly left: number
  /** Top edge of the first row, from the top edge of the sheet. */
  readonly top: number
  /** Column to column, centre to centre — label width plus the gap. */
  readonly pitchX: number
  /** Row to row. Zero vertical gap is usual: label stock is butt-cut vertically. */
  readonly pitchY: number
}

const A4_WIDTH = 210 * MM
const A4_HEIGHT = 297 * MM

/**
 * Centres a grid horizontally on the sheet.
 *
 * Avery's own template puts L7160 about 0.18mm right of centre, which is below the ±2mm
 * manufacturing tolerance of the sheet itself and is almost certainly an artefact of Word's
 * twip rounding. Centring geometrically from the verified pitches is the more defensible
 * number, and it is what the manufacturer's independent specification agrees with.
 */
function centred(columns: number, labelWidth: number, pitchX: number, pageWidth: number): number {
  const span = (columns - 1) * pitchX + labelWidth
  return (pageWidth - span) / 2
}

/** L7160 / J8160 — 21 per sheet, 63.5 × 38.1mm. The common European address label. */
export const AVERY_L7160: LabelStock = {
  code: 'L7160',
  pageWidth: A4_WIDTH,
  pageHeight: A4_HEIGHT,
  columns: 3,
  rows: 7,
  labelWidth: 63.5 * MM,
  labelHeight: 38.1 * MM,
  left: centred(3, 63.5 * MM, 66.04 * MM, A4_WIDTH),
  top: 15.15 * MM,
  pitchX: 66.04 * MM,
  pitchY: 38.1 * MM,
}

/** L7163 / J8163 — 14 per sheet, 99.06 × 38.1mm. Wider, for a longer device name. */
export const AVERY_L7163: LabelStock = {
  code: 'L7163',
  pageWidth: A4_WIDTH,
  pageHeight: A4_HEIGHT,
  columns: 2,
  rows: 7,
  labelWidth: 99.06 * MM,
  labelHeight: 38.1 * MM,
  left: centred(2, 99.06 * MM, 101.6 * MM, A4_WIDTH),
  top: 15.15 * MM,
  pitchX: 101.6 * MM,
  pitchY: 38.1 * MM,
}

/**
 * 5160 — 30 per sheet on US Letter, 2⅝ × 1in.
 *
 * The *role* equivalent of L7160 and not a geometric one: different page, different label,
 * different count. Measured from Avery's own PDF template, where every box — media, crop,
 * bleed and trim — is the full sheet.
 */
export const AVERY_5160: LabelStock = {
  code: '5160',
  pageWidth: 8.5 * 72,
  pageHeight: 11 * 72,
  columns: 3,
  rows: 10,
  labelWidth: 2.625 * 72,
  labelHeight: 1 * 72,
  left: 0.1875 * 72,
  top: 0.5 * 72,
  pitchX: 2.75 * 72,
  pitchY: 1 * 72,
}

/** The stocks offered, in the order a chooser should list them. */
export const LABEL_STOCKS: readonly LabelStock[] = [AVERY_L7160, AVERY_L7163, AVERY_5160]

/**
 * How much of each label to leave clear of ink.
 *
 * Sheet-feed registration drifts by more than any arithmetic here can account for, so a design
 * printed to the die-cut edge lands over it often enough to matter. Two millimetres is the
 * conventional allowance and costs very little of a 63mm label.
 */
export const LABEL_SAFE_INSET = 2 * MM

/** Where a label sits on the page, and what goes on it. */
export interface PlacedLabel {
  readonly device: DeviceDocument
  readonly roomPath: string
  /** From the left edge of the sheet, to the label's left edge. */
  readonly x: number
  /** From the **top** edge of the sheet, matching the rest of `pdf/`. */
  readonly y: number
  readonly width: number
  readonly height: number
}

export interface LabelPage {
  readonly number: number
  readonly labels: readonly PlacedLabel[]
}

/** A device and the room it is in, which is what a label shows besides the code. */
export interface LabelSubject {
  readonly device: DeviceDocument
  readonly roomPath: string
}

/**
 * Where on a part-used sheet to start, 1-based.
 *
 * 1-based because the user is looking at a physical sheet and counting rows with a finger,
 * and "row 0" is not a thing anyone says about a piece of paper.
 */
export interface LabelStart {
  readonly row: number
  readonly column: number
}

/** The first label on a fresh sheet. */
export const FIRST_LABEL: LabelStart = { row: 1, column: 1 }

/**
 * Places labels on sheets, skipping the ones already peeled off the first one.
 *
 * The skipping is the small feature the issue calls disproportionately appreciated, and it is
 * right: nobody wants to waste most of a sheet to print four labels.
 *
 * A start position outside the sheet is clamped rather than refused. It arrives from a number
 * input, where a stray keystroke is far more likely than an intention, and the harm of clamping
 * is one misplaced sheet against an export that refuses to run.
 *
 * @param subjects the devices to print, in order
 * @param stock which sheet
 * @param start where on the first sheet to begin
 * @returns pages of placed labels. Empty when there is nothing to print, which falls out of the
 *   loop rather than being special-cased — an early return for it was dead code, and the probe
 *   said so. Unlike the inventory, a label sheet with nothing on it must not be produced: a
 *   blank page wastes a sheet of paper, a blank label sheet wastes adhesive stock.
 */
export function layoutLabels(
  subjects: readonly LabelSubject[],
  stock: LabelStock,
  start: LabelStart = FIRST_LABEL,
): readonly LabelPage[] {
  const perSheet = stock.columns * stock.rows
  const clamp = (value: number, max: number) =>
    Number.isFinite(value) ? Math.min(Math.max(Math.trunc(value), 1), max) : 1
  const skipped =
    (clamp(start.row, stock.rows) - 1) * stock.columns + (clamp(start.column, stock.columns) - 1)

  const pages: PlacedLabel[][] = []
  subjects.forEach((subject, index) => {
    // The offset is applied to the whole run, so the first sheet is short by exactly the
    // labels already used and every sheet after it is full. Treating it as a per-sheet offset
    // would leave the same corner blank on every sheet.
    const position = index + skipped
    const sheet = Math.floor(position / perSheet)
    const cell = position % perSheet

    pages[sheet] ??= []
    pages[sheet]?.push({
      device: subject.device,
      roomPath: subject.roomPath,
      x: stock.left + (cell % stock.columns) * stock.pitchX,
      y: stock.top + Math.floor(cell / stock.columns) * stock.pitchY,
      width: stock.labelWidth,
      height: stock.labelHeight,
    })
  })

  return pages.map((labels, index) => ({ number: index + 1, labels: labels ?? [] }))
}
