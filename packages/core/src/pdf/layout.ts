/**
 * Where everything goes on the page, decided before any PDF exists.
 *
 * Pagination is arithmetic over plain data, so it lives here and is tested in milliseconds
 * with no bytes written. That is not tidiness: the failures worth catching in an inventory are
 * all *layout* failures — a device that appears twice, one that appears on no page at all, a
 * room heading stranded at the foot of a page above nothing, an entry drawn past the bottom
 * margin and clipped by the printer. Every one of those is a property of the plan rather than
 * of the drawing, and none of them is visible in a byte comparison of a PDF.
 *
 * **Grouping is not decided here.** `browseDevices` already decides what the project contains
 * and how it is grouped, for the screen; the export uses the same answer. A second grouping
 * rule would let the PDF and the list disagree about the same project, which is the sort of
 * bug people only find when they have printed something.
 *
 * Units are PostScript points throughout — 72 to the inch — because that is what PDF uses and
 * converting at the boundary is one conversion rather than one per call.
 *
 * @module
 */

import type { DeviceGroup } from '../documents/browse.js'
import type { DeviceDocument } from '../documents/types.js'

/** A4 in points, and the room left around the content. */
export interface PageGeometry {
  readonly width: number
  readonly height: number
  readonly margin: number
  /** How tall one device's entry is, including the space beneath it. */
  readonly entryHeight: number
  /** How tall a room heading is, including the space beneath it. */
  readonly headingHeight: number
  /** Room left at the foot of every page for the page number. */
  readonly footerHeight: number
}

/**
 * A4 portrait.
 *
 * A4 rather than Letter because German is a launch language and the houses this catalogues are
 * in Europe. M8 can make it a choice; guessing at one now would be a setting nobody asked for.
 */
export const A4: PageGeometry = {
  width: 595.28,
  height: 841.89,
  margin: 42,
  // Room for a 96pt QR code plus the four lines of text beside it, and a gap.
  entryHeight: 116,
  headingHeight: 30,
  footerHeight: 24,
}

/** A room's name, above the devices in it. */
export interface HeadingBlock {
  readonly kind: 'heading'
  readonly path: string
  /** The distance from the top of the page to the top of this block. */
  readonly top: number
  /**
   * Whether this heading is repeating a room that started on an earlier page.
   *
   * A reader who turns the page into the middle of a long room otherwise has no idea what they
   * are looking at — the devices are just names. Repeating the heading costs one line and the
   * flag lets the renderer say "continued" rather than implying the room started here.
   */
  readonly continued: boolean
}

/** One device. */
export interface EntryBlock {
  readonly kind: 'entry'
  readonly device: DeviceDocument
  readonly roomPath: string
  readonly top: number
}

export type Block = HeadingBlock | EntryBlock

/** One page, in order. */
export interface Page {
  /** 1-based, as printed. */
  readonly number: number
  readonly blocks: readonly Block[]
}

/**
 * Lays the inventory out on pages.
 *
 * Two rules do all the work, and both exist because of how the result is read on paper rather
 * than on screen:
 *
 * - **A heading is never the last block on a page.** A room name at the foot of a page, with
 *   its devices overleaf, reads as a room containing nothing.
 * - **A room continued onto a new page repeats its heading**, marked as a continuation.
 *
 * @param groups from `browseDevices` — already filtered and ordered
 * @param geometry the page, defaulting to {@link A4}
 * @returns pages in order. Always at least one, even when there is nothing to print: a
 *   zero-page PDF is a file that will not open, which is a worse answer to "an empty project"
 *   than a page saying there is nothing.
 */
export function layoutInventory(
  groups: readonly DeviceGroup[],
  geometry: PageGeometry = A4,
): readonly Page[] {
  const usable = geometry.height - geometry.margin * 2 - geometry.footerHeight
  const pages: Block[][] = [[]]
  let cursor = 0

  const current = () => pages[pages.length - 1] as Block[]
  const newPage = () => {
    pages.push([])
    cursor = 0
  }

  for (const group of groups) {
    for (const [index, device] of group.devices.entries()) {
      // The heading and its first device are measured and placed **together**, never
      // separately. Asking "does the heading fit?" on its own is exactly how one ends up alone
      // at the foot of a page: it fits, and then the device after it does not.
      const starting = index === 0
      const needed = geometry.entryHeight + (starting ? geometry.headingHeight : 0)

      let heading = starting
      let continued = false

      if (cursor + needed > usable && current().length > 0) {
        newPage()
        // Anything mid-room now begins a page, and a room that spans the break has to say so —
        // a reader turning into the middle of a long room otherwise sees only names.
        //
        // A room *starting* here keeps `heading` from above and is not a continuation. Getting
        // this wrong in the obvious way (an `else if` on the heading) silently drops the
        // heading of any room whose first device happens to land on a page boundary, which a
        // test caught before this was believed.
        if (!starting) {
          heading = true
          continued = true
        }
      }

      if (heading) {
        current().push({ kind: 'heading', path: group.path, top: cursor, continued })
        cursor += geometry.headingHeight
      }

      current().push({ kind: 'entry', device, roomPath: group.path, top: cursor })
      cursor += geometry.entryHeight
    }
  }

  return pages.map((blocks, index) => ({ number: index + 1, blocks }))
}

/** Every device on a page, in order. Convenience for callers that only draw entries. */
export function entriesOf(page: Page): readonly EntryBlock[] {
  return page.blocks.filter((block): block is EntryBlock => block.kind === 'entry')
}
