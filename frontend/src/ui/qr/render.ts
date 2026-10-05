/**
 * Drawing an encoded symbol: as SVG on screen, as a vector path in the PDFs.
 *
 * Both outputs come from one path string, {@link qrPath}, so the screen and the paper cannot
 * drift apart. That string is also the point of drawing it ourselves. `<wa-qr-code>` painted
 * a canvas whose three corner squares took their colour from the theme's text colour rather
 * than from its `fill`. In dark mode that turned them light grey, and the code stopped
 * scanning. Here the colours are written into the markup and nothing inherits them.
 *
 * @module
 */

import { html, type TemplateResult } from 'lit'
import { encodeQr, type QrMatrix } from './encode.js'

/**
 * The dark modules as one SVG path, in module units, with the origin at the top left.
 *
 * Each horizontal run of dark modules is a single rectangle. A 25-module code becomes about
 * 150 subpaths rather than 300 squares, and runs leave no seams between neighbours for an
 * anti-aliasing renderer to show as hairlines.
 */
export function qrPath(matrix: QrMatrix): string {
  const parts: string[] = []
  for (let row = 0; row < matrix.size; row += 1) {
    let column = 0
    while (column < matrix.size) {
      if (!matrix.isDark(row, column)) {
        column += 1
        continue
      }
      const start = column
      while (column < matrix.size && matrix.isDark(row, column)) column += 1
      parts.push(`M${start} ${row}h${column - start}v1h-${column - start}z`)
    }
  }
  return parts.join('')
}

/**
 * A Matter payload as an inline SVG image.
 *
 * Black on white, both literal, for the reasons in `views/device.ts`: an inverted code is one
 * many scanners refuse, and maximum contrast is the whole job. The white square is part of
 * the image rather than borrowed from the surrounding plate, so the code stays correct when
 * it is copied, printed or rendered somewhere the plate's CSS does not reach.
 *
 * The quiet zone is **not** included. It belongs to the plate around the image, which sizes
 * it in the same units as the rest of the layout.
 *
 * @param payload the `MT:` string. A secret: it is never logged, and the accessible name is
 *   `label`, not the payload.
 * @param size the rendered width and height, in CSS pixels
 * @param label the accessible name
 */
export function qrSvg(payload: string, size: number, label: string): TemplateResult {
  const matrix = encodeQr(payload)
  return html`
    <svg
      class="app-qr"
      role="img"
      aria-label=${label}
      width=${size}
      height=${size}
      viewBox="0 0 ${matrix.size} ${matrix.size}"
      shape-rendering="crispEdges"
    >
      <rect width=${matrix.size} height=${matrix.size} fill="white"></rect>
      <path d=${qrPath(matrix)} fill="black"></path>
    </svg>
  `
}
