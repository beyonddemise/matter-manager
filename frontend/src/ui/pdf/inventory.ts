/**
 * Writing the inventory PDF.
 *
 * Entirely in the browser (ADR 0007), which is what makes it work in a basement — the place
 * this application is most often used and least often connected.
 *
 * The division of labour is the one this repository uses everywhere: `core` decided *where*
 * everything goes (`pdf/layout.ts`, and every page-break invariant is tested there), and this
 * file does the impure half — drawing codes and writing bytes.
 *
 * @module
 */

import { PDFDocument, rgb, StandardFonts } from 'pdf-lib'
import {
  A4,
  type DeviceGroup,
  type EntryBlock,
  type HeadingBlock,
  layoutInventory,
  manufacturerName,
  type PageGeometry,
  roomPathBreadcrumb,
} from '../../domain/index.js'
import { ExportCancelled, type InventoryProgress } from './progress.js'
import { drawQr } from './qr.js'
import { winAnsiSafe } from './win-ansi.js'
import { yieldToBrowser } from './yield.js'

// Re-exported from where they used to be declared, because this is the module every caller and
// every test already names them from. They moved to `progress.ts` so that `device-list.ts` can
// hold `ExportCancelled` for its `catch` without statically importing this file and dragging
// `pdf-lib` back into the entry bundle; see that module for the whole reason.
export { ExportCancelled, type InventoryProgress }

/** How large the code is drawn, in points. About 34mm — comfortably scannable off paper. */
export const QR_SIZE = 96

/** Text sizes, in points. */
const HEADING_SIZE = 13
const NAME_SIZE = 11
const DETAIL_SIZE = 9

/** What the caller has to supply that this module cannot know. */
export interface InventoryLabels {
  readonly title: string
  /** Given the page and the total, e.g. "Page 2 of 7". Translated by the caller. */
  readonly pageNumber: (page: number, total: number) => string
  /** Marks a room heading repeated after a page break. */
  readonly continued: (path: string) => string
  readonly installed: string
  readonly pairingCode: string
  /** Precedes the manufacturer's part number, e.g. "Part number". */
  readonly partNumber: string
  /** Shown in place of a QR for a device filed from a typed pairing code. */
  readonly noQrCode: string
  readonly withoutRoom: string
  readonly nothingToExport: string
}

export interface InventoryOptions {
  readonly labels: InventoryLabels
  readonly geometry?: PageGeometry
  readonly onProgress?: (progress: InventoryProgress) => void
  /** Checked between devices; when it returns true the export stops and throws. */
  readonly cancelled?: () => boolean
}

/** A Matter id as the device page writes it, e.g. `0x8000`. */
const hex = (value: number): string => `0x${value.toString(16).toUpperCase().padStart(4, '0')}`

/**
 * A device's product, in whatever form is known.
 *
 * The manufacturer is printed whenever it is known, as on the device page (ruling R27): beside
 * the model name, or beside the hex product id when the catalogue named the vendor but not the
 * model (and for every test vendor). It then takes the place of the hex vendor id it names.
 */
function productOf(entry: EntryBlock): string | undefined {
  const device = entry.device
  // The preferred name: what people call the company, and what the device page shows.
  const manufacturer = manufacturerName(device)
  if (device.productName !== undefined) {
    return manufacturer === undefined ? device.productName : `${manufacturer} ${device.productName}`
  }
  if (device.productId === undefined) return manufacturer
  const vendor = manufacturer ?? (device.vendorId === undefined ? undefined : hex(device.vendorId))
  return vendor === undefined ? hex(device.productId) : `${vendor} / ${hex(device.productId)}`
}

/** What a cut line ends in. WinAnsi has it (0x85), so the standard fonts can draw it. */
const ELLIPSIS = '…'

type Font = Awaited<ReturnType<PDFDocument['embedFont']>>

/**
 * Makes text drawable and cuts it to one line of the given width.
 *
 * Why not `drawText`'s `maxWidth`: that *wraps*, at `pdf-lib`'s default 24pt line height, and
 * the entry's height is a fixed budget (`A4.entryHeight`), so a long name or spot drew over the
 * next line or the next entry (#238). Free text has no length limit; one line with an ellipsis
 * is the honest rendering on paper, and the full text is still on the device page.
 *
 * @param text as stored; made WinAnsi-safe here, before it is measured
 * @param font the font it will be drawn in, whose metrics decide the cut
 * @param size the font size, in points
 * @param width the column width, in points
 * @returns the text unchanged when it fits, otherwise its longest prefix that fits with `…`
 */
function fitToWidth(text: string, font: Font, size: number, width: number): string {
  const safe = winAnsiSafe(text)
  if (font.widthOfTextAtSize(safe, size) <= width) return safe

  // Binary search for the longest prefix that fits with the ellipsis: width grows with length,
  // and a name of a few hundred characters should not cost a few hundred measurements.
  // After `winAnsiSafe` every character is one UTF-16 unit, so slicing cannot split a pair.
  let low = 0
  let high = safe.length
  while (low < high) {
    const middle = Math.ceil((low + high) / 2)
    const candidate = `${safe.slice(0, middle).trimEnd()}${ELLIPSIS}`
    if (font.widthOfTextAtSize(candidate, size) <= width) low = middle
    else high = middle - 1
  }
  return `${safe.slice(0, low).trimEnd()}${ELLIPSIS}`
}

/**
 * Builds the PDF.
 *
 * @param groups from `browseDevices`, so the export and the screen agree about what the
 *   project contains
 * @returns the PDF bytes
 * @throws {ExportCancelled} if asked to stop
 */
export async function buildInventoryPdf(
  groups: readonly DeviceGroup[],
  options: InventoryOptions,
): Promise<Uint8Array> {
  const geometry = options.geometry ?? A4
  const labels = options.labels
  const pages = layoutInventory(groups, geometry)

  const pdf = await PDFDocument.create()
  // Helvetica and Helvetica-Bold cover Latin-1, which includes every character German needs —
  // ä, ö, ü, ß. M3-4 is where that stops being an assumption and becomes a test that extracts
  // the text back out.
  const regular = await pdf.embedFont(StandardFonts.Helvetica)
  const bold = await pdf.embedFont(StandardFonts.HelveticaBold)

  const ink = rgb(0.07, 0.08, 0.09)
  const quiet = rgb(0.42, 0.45, 0.48)

  const total = groups.reduce((count, group) => count + group.devices.length, 0)
  let done = 0

  for (const laid of pages) {
    const page = pdf.addPage([geometry.width, geometry.height])
    /** PDF's origin is the bottom-left; the layout counts down from the top. */
    const yOf = (top: number) => geometry.height - geometry.margin - top

    for (const block of laid.blocks) {
      if (block.kind === 'heading') {
        drawHeading(page, block, { yOf, geometry, bold, ink, labels })
        continue
      }

      if (options.cancelled?.() === true) throw new ExportCancelled('The export was cancelled.')

      drawEntry(page, block, { yOf, geometry, regular, bold, ink, quiet, labels })
      done += 1
      options.onProgress?.({ done, total })
      // Once per device, and it is what makes the progress callout above actually appear.
      // Every `await` in this loop settles on a microtask, which continues the *same* task —
      // so without this the whole export is one block and the interface is frozen for its
      // duration. See `yield.ts`.
      await yieldToBrowser()
    }

    if (laid.blocks.length === 0) {
      page.drawText(winAnsiSafe(labels.nothingToExport), {
        x: geometry.margin,
        y: yOf(0),
        size: NAME_SIZE,
        font: regular,
        color: quiet,
      })
    }

    // The footer sits below the usable area, which is exactly what `footerHeight` reserved.
    const footer = winAnsiSafe(labels.pageNumber(laid.number, pages.length))
    page.drawText(footer, {
      x: geometry.width - geometry.margin - regular.widthOfTextAtSize(footer, DETAIL_SIZE),
      y: geometry.margin - DETAIL_SIZE,
      size: DETAIL_SIZE,
      font: regular,
      color: quiet,
    })
  }

  pdf.setTitle(labels.title)
  // Deliberately no author, producer, or keywords beyond the title. Metadata is the quiet way
  // documents carry things nobody meant to publish, and this one is handed to other people.
  //
  // Object streams left on. They were briefly suspected of costing a second per forty pages,
  // and that measurement was wrong: it saved the *same document* twice, and pdf-lib caches its
  // normalisation, so whichever call ran second was fast because the first had done the work.
  // Measured properly on two documents, object streams are the faster of the two (25ms against
  // 61ms for sixty pages) as well as producing the smaller file.
  return pdf.save()
}

type Drawing = {
  readonly yOf: (top: number) => number
  readonly geometry: PageGeometry
  readonly ink: ReturnType<typeof rgb>
  readonly labels: InventoryLabels
}

function drawHeading(
  page: ReturnType<PDFDocument['addPage']>,
  block: HeadingBlock,
  context: Drawing & { readonly bold: Awaited<ReturnType<PDFDocument['embedFont']>> },
): void {
  const { yOf, geometry, bold, ink, labels } = context
  // The same breadcrumb the device list shows (#242): `Attic › Studio`, not `Attic/Studio`.
  // Sub-rooms already follow their parent, because the groups come from `browseDevices`.
  const path = block.path === '' ? labels.withoutRoom : roomPathBreadcrumb(block.path)
  const text = block.continued ? labels.continued(path) : path

  // Fitted to the column, which also makes it WinAnsi-safe. A three-level breadcrumb of long
  // names is wider than the page (#242); cut with an ellipsis it stays on one line above its
  // rule. Missing the WinAnsi step is not a rendering glitch: `pdf-lib` throws on a character
  // WinAnsi cannot encode, so one Polish room name would lose the whole export.
  page.drawText(fitToWidth(text, bold, HEADING_SIZE, geometry.width - 2 * geometry.margin), {
    x: geometry.margin,
    y: yOf(block.top + HEADING_SIZE),
    size: HEADING_SIZE,
    font: bold,
    color: ink,
  })
  // A rule under the heading, so a room's devices read as belonging to it on a dense page.
  page.drawLine({
    start: { x: geometry.margin, y: yOf(block.top + HEADING_SIZE + 6) },
    end: { x: geometry.width - geometry.margin, y: yOf(block.top + HEADING_SIZE + 6) },
    thickness: 0.5,
    color: rgb(0.8, 0.82, 0.84),
  })
}

function drawEntry(
  page: ReturnType<PDFDocument['addPage']>,
  block: EntryBlock,
  context: Drawing & {
    readonly regular: Awaited<ReturnType<PDFDocument['embedFont']>>
    readonly bold: Awaited<ReturnType<PDFDocument['embedFont']>>
    readonly quiet: ReturnType<typeof rgb>
  },
): void {
  const { yOf, geometry, regular, bold, ink, quiet, labels } = context
  const device = block.device
  const left = geometry.margin

  if (device.payload !== undefined) {
    drawQr(page, device.payload, { x: left, top: yOf(block.top), size: QR_SIZE })
  } else {
    // No payload, and none can be invented: a manual code carries only the top four bits of
    // the discriminator, so a reconstructed payload would produce a QR that encodes cleanly
    // and silently fails to commission. Saying so is the honest rendering, and the pairing
    // code below still commissions the device.
    page.drawRectangle({
      x: left,
      y: yOf(block.top + QR_SIZE),
      width: QR_SIZE,
      height: QR_SIZE,
      borderColor: rgb(0.8, 0.82, 0.84),
      borderWidth: 0.5,
    })
    page.drawText(winAnsiSafe(labels.noQrCode), {
      x: left + 8,
      y: yOf(block.top + QR_SIZE / 2),
      size: DETAIL_SIZE,
      font: regular,
      color: quiet,
      maxWidth: QR_SIZE - 16,
      lineHeight: DETAIL_SIZE + 2,
    })
  }

  const textLeft = left + QR_SIZE + 16
  const width = geometry.width - geometry.margin - textLeft
  let line = block.top + NAME_SIZE

  page.drawText(fitToWidth(device.name, bold, NAME_SIZE, width), {
    x: textLeft,
    y: yOf(line),
    size: NAME_SIZE,
    font: bold,
    color: ink,
  })

  const details = [
    productOf(block),
    device.partNumber === undefined ? undefined : `${labels.partNumber}: ${device.partNumber}`,
    `${labels.installed}: ${device.installedAt}`,
    device.spot,
    device.serial,
  ].filter((value): value is string => value !== undefined && value !== '')

  // Every detail is cut to one line, not only spot and serial: the product and part number come
  // from a catalogue this application does not control, and one line per detail is what the
  // entry height was budgeted for.
  for (const detail of details) {
    line += DETAIL_SIZE + 4
    page.drawText(fitToWidth(detail, regular, DETAIL_SIZE, width), {
      x: textLeft,
      y: yOf(line),
      size: DETAIL_SIZE,
      font: regular,
      color: quiet,
    })
  }

  // The pairing code last and in bold: it is the one thing on the entry that still works when
  // the QR has been rained on, and the reason a code-only device is a complete record.
  line += DETAIL_SIZE + 8
  page.drawText(winAnsiSafe(`${labels.pairingCode}: ${device.manualCode}`), {
    x: textLeft,
    y: yOf(line),
    size: DETAIL_SIZE + 1,
    font: bold,
    color: ink,
    maxWidth: width,
  })
}
