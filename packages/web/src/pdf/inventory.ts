/**
 * Writing the inventory PDF.
 *
 * Entirely in the browser (ADR 0007), which is what makes it work in a basement — the place
 * this application is most often used and least often connected.
 *
 * The division of labour is the one this repository uses everywhere: `core` decided *where*
 * everything goes (`pdf/layout.ts`, and every page-break invariant is tested there), and this
 * file does the impure half — rasterising codes and writing bytes.
 *
 * @module
 */

import {
  A4,
  type DeviceGroup,
  type EntryBlock,
  type HeadingBlock,
  layoutInventory,
  type PageGeometry,
} from '@matter-manager/core'
import { PDFDocument, rgb, StandardFonts } from 'pdf-lib'
import { renderQrPng } from './qr-image.js'
import { winAnsiSafe } from './win-ansi.js'
import { yieldToBrowser } from './yield.js'

/** How large the code is drawn, in points. About 34mm — comfortably scannable off paper. */
const QR_SIZE = 96

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
  /** Shown in place of a QR for a device filed from a typed pairing code. */
  readonly noQrCode: string
  readonly withoutRoom: string
  readonly nothingToExport: string
}

/** Progress, so a long export can say what it is doing. M3-5 builds on this. */
export interface InventoryProgress {
  readonly done: number
  readonly total: number
}

export interface InventoryOptions {
  readonly labels: InventoryLabels
  readonly geometry?: PageGeometry
  readonly onProgress?: (progress: InventoryProgress) => void
  /** Checked between devices; when it returns true the export stops and throws. */
  readonly cancelled?: () => boolean
}

/** Thrown when {@link InventoryOptions.cancelled} asked for a stop. */
export class ExportCancelled extends Error {
  override readonly name = 'ExportCancelled'
}

/** A device's product, in whatever form is known. */
function productOf(entry: EntryBlock): string | undefined {
  const device = entry.device
  if (device.productName !== undefined) {
    return device.vendorName === undefined
      ? device.productName
      : `${device.vendorName} ${device.productName}`
  }
  if (device.productId === undefined) return undefined
  const hex = (value: number) => `0x${value.toString(16).toUpperCase().padStart(4, '0')}`
  return device.vendorId === undefined
    ? hex(device.productId)
    : `${hex(device.vendorId)} / ${hex(device.productId)}`
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

      await drawEntry(page, block, { yOf, geometry, regular, bold, ink, quiet, labels, pdf })
      // `embedPng` is **lazy**: it registers an embedder and does the decoding and deflating
      // at save time. Left alone, two hundred images are processed in one synchronous call at
      // the end — which measured as a 5.6-second freeze *after* the last progress callback,
      // with the loop above looking perfectly well-behaved. Flushing here does that work now,
      // inside the loop, where the yield below can break it up.
      await pdf.flush()
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
  //
  // The real cost was the deferred image embedding flushed above.
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
  const path = block.path === '' ? labels.withoutRoom : block.path
  const text = block.continued ? labels.continued(path) : path

  // Every string that reaches `drawText` goes through this. Missing one is not a rendering
  // glitch: `pdf-lib` throws on a character WinAnsi cannot encode, so one Polish room name
  // would lose the whole export. See `win-ansi.ts`.
  page.drawText(winAnsiSafe(text), {
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

async function drawEntry(
  page: ReturnType<PDFDocument['addPage']>,
  block: EntryBlock,
  context: Drawing & {
    readonly regular: Awaited<ReturnType<PDFDocument['embedFont']>>
    readonly bold: Awaited<ReturnType<PDFDocument['embedFont']>>
    readonly quiet: ReturnType<typeof rgb>
    readonly pdf: PDFDocument
  },
): Promise<void> {
  const { yOf, geometry, regular, bold, ink, quiet, labels, pdf } = context
  const device = block.device
  const left = geometry.margin

  if (device.payload !== undefined) {
    const png = await pdf.embedPng(await renderQrPng(device.payload, QR_SIZE))
    page.drawImage(png, {
      x: left,
      y: yOf(block.top + QR_SIZE),
      width: QR_SIZE,
      height: QR_SIZE,
    })
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

  page.drawText(winAnsiSafe(device.name), {
    x: textLeft,
    y: yOf(line),
    size: NAME_SIZE,
    font: bold,
    color: ink,
    maxWidth: width,
  })

  const details = [
    productOf(block),
    `${labels.installed}: ${device.installedAt}`,
    device.spot,
    device.serial,
  ].filter((value): value is string => value !== undefined && value !== '')

  for (const detail of details) {
    line += DETAIL_SIZE + 4
    page.drawText(winAnsiSafe(detail), {
      x: textLeft,
      y: yOf(line),
      size: DETAIL_SIZE,
      font: regular,
      color: quiet,
      maxWidth: width,
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
