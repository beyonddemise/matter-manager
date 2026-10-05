/**
 * The QR code on a PDF page, drawn as vector paths.
 *
 * The same symbol and the same path as on screen (`qr/render.ts`), so a printed label and
 * the device page can never disagree. Being vector, it is exact at any print size, and no
 * render resolution has to be chosen and justified.
 *
 * @module
 */

import { type PDFPage, rgb } from 'pdf-lib'
import { encodeQr } from '../qr/encode.js'
import { QUIET_ZONE, qrPath } from '../qr/render.js'

/** Where the code goes, in PDF points. `top` is the PDF y coordinate of its upper edge. */
export interface QrPlacement {
  readonly x: number
  readonly top: number
  readonly size: number
}

/**
 * Draws a payload's QR code, black on white, as a `size`-point square that includes its
 * quiet zone.
 *
 * The quiet zone is inside `size` because a label leaves only a few millimetres between the
 * code, the die-cut edge and the text beside it, less than four modules. Inside, it is four
 * modules at any size and any version, whatever the caller's layout does.
 *
 * The white square is drawn explicitly although paper is white anyway. A PDF viewer in dark
 * mode, or a page someone has tinted, would otherwise show the modules on whatever is
 * behind them.
 *
 * @param payload the `MT:` string. **A secret**: never logged, here or by the caller.
 */
export function drawQr(page: PDFPage, payload: string, placement: QrPlacement): void {
  const matrix = encodeQr(payload)
  const scale = placement.size / (matrix.size + QUIET_ZONE * 2)
  const inset = QUIET_ZONE * scale
  page.drawRectangle({
    x: placement.x,
    y: placement.top - placement.size,
    width: placement.size,
    height: placement.size,
    color: rgb(1, 1, 1),
  })
  // `drawSvgPath` takes SVG's y-down coordinates from the given origin and flips them
  // itself, so the top-left path from `qrPath` goes in unchanged.
  page.drawSvgPath(qrPath(matrix), {
    x: placement.x + inset,
    y: placement.top - inset,
    scale,
    color: rgb(0, 0, 0),
  })
}
