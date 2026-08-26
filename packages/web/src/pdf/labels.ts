/**
 * Writing a sheet of adhesive labels.
 *
 * Shares everything it can with the inventory: the same off-screen QR rasteriser, the same
 * progress and cancellation seams, the same rule that `core` decided where things go. What is
 * different is the target — a physical die-cut sheet — and that changes one thing about the
 * drawing: **nothing may be scaled.** The page is exactly the sheet, and the positions are
 * absolute on it.
 *
 * @module
 */

import {
  type DeviceGroup,
  LABEL_SAFE_INSET,
  type LabelStart,
  type LabelStock,
  type LabelSubject,
  layoutLabels,
  MM,
  type PlacedLabel,
} from '@matter-manager/core'
import { PDFDocument, rgb, StandardFonts } from 'pdf-lib'
import { ExportCancelled, type InventoryProgress } from './inventory.js'
import { renderQrPng } from './qr-image.js'
import { winAnsiSafe } from './win-ansi.js'

export interface LabelOptions {
  readonly stock: LabelStock
  readonly start?: LabelStart
  readonly title: string
  /** What a label says instead of a QR when the device was filed from a pairing code. */
  readonly noQrCode: string
  readonly withoutRoom: string
  readonly onProgress?: (progress: InventoryProgress) => void
  readonly cancelled?: () => boolean
}

/** Flattens the groups into what a label needs: a device, and the room it is in. */
export function labelSubjects(groups: readonly DeviceGroup[]): readonly LabelSubject[] {
  return groups.flatMap((group) =>
    group.devices.map((device) => ({ device, roomPath: group.path })),
  )
}

/**
 * Shortens text to fit a width, ending in an ellipsis when it has to.
 *
 * A label is 63mm wide and a device name can be anything. `pdf-lib` does not wrap or clip — it
 * draws past the edge, across the die-cut, onto the next label. So the choice is between
 * truncating and producing a sheet where one label's name runs into its neighbour's, and
 * truncating is the only one of those a person can read.
 */
function fitted(
  raw: string,
  font: Awaited<ReturnType<PDFDocument['embedFont']>>,
  size: number,
  width: number,
): string {
  // Made safe *before* measuring, not after: a substitution changes the width, so measuring
  // the original would fit a string that is not the one drawn.
  const text = winAnsiSafe(raw)
  if (font.widthOfTextAtSize(text, size) <= width) return text

  const ellipsis = '…'
  let kept = text
  while (kept.length > 1 && font.widthOfTextAtSize(kept + ellipsis, size) > width) {
    kept = kept.slice(0, -1)
  }
  return kept + ellipsis
}

/**
 * Builds the label sheet.
 *
 * @returns the PDF bytes, or an empty document's worth when there is nothing to print
 * @throws {ExportCancelled} if asked to stop
 */
export async function buildLabelPdf(
  groups: readonly DeviceGroup[],
  options: LabelOptions,
): Promise<Uint8Array> {
  const stock = options.stock
  const subjects = labelSubjects(groups)
  const sheets = layoutLabels(subjects, stock, options.start)

  const pdf = await PDFDocument.create()
  const regular = await pdf.embedFont(StandardFonts.Helvetica)
  const bold = await pdf.embedFont(StandardFonts.HelveticaBold)
  const ink = rgb(0.07, 0.08, 0.09)
  const quiet = rgb(0.42, 0.45, 0.48)

  let done = 0

  for (const sheet of sheets) {
    // Exactly the sheet, with no bleed and no inset: Avery's own templates set every box —
    // media, crop, bleed and trim — to the full page, because the label geometry is absolute
    // on the physical stock. The document must be printed at 100%, never fit-to-page.
    const page = pdf.addPage([stock.pageWidth, stock.pageHeight])
    const yOf = (top: number) => stock.pageHeight - top

    for (const label of sheet.labels) {
      if (options.cancelled?.() === true) throw new ExportCancelled('The export was cancelled.')
      await drawLabel(page, label, { pdf, regular, bold, ink, quiet, yOf, options })
      done += 1
      options.onProgress?.({ done, total: subjects.length })
    }
  }

  // A document with no pages will not open. Label sheets produce none when there is nothing to
  // print — deliberately, because a blank sheet wastes adhesive stock — so one is added here
  // rather than in the layout, where it would mean printing a blank sheet in the normal case.
  if (sheets.length === 0) pdf.addPage([stock.pageWidth, stock.pageHeight])

  pdf.setTitle(options.title)
  return pdf.save()
}

async function drawLabel(
  page: ReturnType<PDFDocument['addPage']>,
  label: PlacedLabel,
  context: {
    readonly pdf: PDFDocument
    readonly regular: Awaited<ReturnType<PDFDocument['embedFont']>>
    readonly bold: Awaited<ReturnType<PDFDocument['embedFont']>>
    readonly ink: ReturnType<typeof rgb>
    readonly quiet: ReturnType<typeof rgb>
    readonly yOf: (top: number) => number
    readonly options: LabelOptions
  },
): Promise<void> {
  const { pdf, regular, bold, ink, quiet, yOf, options } = context
  const device = label.device

  // Ink stays clear of the die-cut edge. Sheet-feed registration drifts by more than any
  // arithmetic here can account for, so a design printed to the edge lands over it often
  // enough to matter.
  const inset = LABEL_SAFE_INSET
  const left = label.x + inset
  const top = label.y + inset
  const height = label.height - inset * 2
  const width = label.width - inset * 2

  // Square, and as tall as the label allows: the code is the reason the label exists, and a
  // code shrunk to leave room for text is a code that does not scan off a fuse box.
  const qrSize = Math.min(height, label.width * 0.4)

  if (device.payload !== undefined) {
    const png = await pdf.embedPng(await renderQrPng(device.payload, qrSize))
    page.drawImage(png, { x: left, y: yOf(top + qrSize), width: qrSize, height: qrSize })
  } else {
    page.drawRectangle({
      x: left,
      y: yOf(top + qrSize),
      width: qrSize,
      height: qrSize,
      borderColor: rgb(0.8, 0.82, 0.84),
      borderWidth: 0.5,
    })
  }

  const textLeft = left + qrSize + 3 * MM
  const textWidth = width - qrSize - 3 * MM
  const nameSize = 9
  const detailSize = 7

  page.drawText(fitted(device.name, bold, nameSize, textWidth), {
    x: textLeft,
    y: yOf(top + nameSize),
    size: nameSize,
    font: bold,
    color: ink,
  })

  const room = label.roomPath === '' ? options.withoutRoom : label.roomPath
  page.drawText(fitted(room, regular, detailSize, textWidth), {
    x: textLeft,
    y: yOf(top + nameSize + detailSize + 3),
    size: detailSize,
    font: regular,
    color: quiet,
  })

  // The pairing code, because a label rained on inside a fuse box is where a QR fails and
  // digits still work. Truncation would make it useless rather than degraded, so it is drawn
  // at whatever size fits: a code a reader has to squint at beats one that is cut in half.
  // Digits only, so the guard is a no-op — applied anyway, so that every `drawText` in this
  // file goes through it and none can be forgotten when this changes.
  const code = winAnsiSafe(device.manualCode)
  let codeSize = detailSize
  while (codeSize > 4 && regular.widthOfTextAtSize(code, codeSize) > textWidth) codeSize -= 0.25

  page.drawText(code, {
    x: textLeft,
    y: yOf(top + nameSize + detailSize * 2 + 7),
    size: codeSize,
    font: regular,
    color: ink,
  })

  if (device.payload === undefined) {
    page.drawText(fitted(options.noQrCode, regular, 5, qrSize), {
      x: left + 2,
      y: yOf(top + qrSize / 2),
      size: 5,
      font: regular,
      color: quiet,
    })
  }
}
