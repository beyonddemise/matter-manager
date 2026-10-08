/**
 * QR codes as pixels, for browser tests that need something a decoder can read.
 *
 * @module
 */

import { encodeQr } from '../../../src/ui/qr/encode.js'

/** The quiet zone ISO/IEC 18004 asks for, in modules. */
const QUIET_ZONE = 4

/**
 * A canvas showing the payload's code, black on white, with a full quiet zone.
 *
 * Drawn module by module from the encoder, which the node tests hold to a real label and to
 * python-qrcode. So a decoder test reading this canvas reads the same symbol the app shows.
 */
export function qrCanvas(payload: string, moduleSize = 8): HTMLCanvasElement {
  const matrix = encodeQr(payload)
  const canvas = document.createElement('canvas')
  canvas.width = (matrix.size + QUIET_ZONE * 2) * moduleSize
  canvas.height = canvas.width
  const context = canvas.getContext('2d') as CanvasRenderingContext2D
  context.fillStyle = 'white'
  context.fillRect(0, 0, canvas.width, canvas.height)
  context.fillStyle = 'black'
  for (let row = 0; row < matrix.size; row += 1) {
    for (let column = 0; column < matrix.size; column += 1) {
      if (matrix.isDark(row, column)) {
        context.fillRect(
          (column + QUIET_ZONE) * moduleSize,
          (row + QUIET_ZONE) * moduleSize,
          moduleSize,
          moduleSize,
        )
      }
    }
  }
  return canvas
}

/**
 * What the browser actually paints for an inline SVG, as a canvas, with a white margin
 * standing in for the plate around it.
 *
 * The SVG is serialised and drawn through an image, so the result includes every presentation
 * attribute it carries. CSS from the page does not reach it, and that is the point: the code
 * must be correct on its own, whatever the theme around it does.
 */
export async function rasterize(svg: SVGSVGElement, size = 400): Promise<HTMLCanvasElement> {
  const source = new XMLSerializer().serializeToString(svg)
  const image = new Image()
  image.src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(source)}`
  await image.decode()

  const margin = size / 8
  const canvas = document.createElement('canvas')
  canvas.width = size + margin * 2
  canvas.height = canvas.width
  const context = canvas.getContext('2d') as CanvasRenderingContext2D
  context.fillStyle = 'white'
  context.fillRect(0, 0, canvas.width, canvas.height)
  context.drawImage(image, margin, margin, size, size)
  return canvas
}
