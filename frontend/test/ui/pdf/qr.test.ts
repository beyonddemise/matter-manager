import type { PDFPage } from 'pdf-lib'
import { describe, expect, it } from 'vitest'
import { drawQr } from '../../../src/ui/pdf/qr.js'
import { encodeQr } from '../../../src/ui/qr/encode.js'
import { qrPath } from '../../../src/ui/qr/render.js'

const PAYLOAD = 'MT:Y.K9042C00KA0648G00'

/** A page that records what is drawn on it, in order. */
function recordingPage() {
  const calls: { method: string; args: unknown[] }[] = []
  const record =
    (method: string) =>
    (...args: unknown[]) => {
      calls.push({ method, args })
    }
  const page = { drawRectangle: record('drawRectangle'), drawSvgPath: record('drawSvgPath') }
  return { page: page as unknown as PDFPage, calls }
}

describe('drawQr', () => {
  // The path itself is proven against the matrix in `qr/render.test.ts`, and the matrix
  // against a real label in `qr/encode.test.ts`. What is left to prove here is placement.
  it('draws the encoded symbol, black, inset by the quiet zone inside the given square', () => {
    const { page, calls } = recordingPage()

    // 25 modules plus four of quiet zone on each side is 33, so 132 points is four a module
    // and the quiet zone is sixteen points. ISO/IEC 18004 asks for four modules; a label
    // leaves less than that between the code, the die-cut edge and the text.
    drawQr(page, PAYLOAD, { x: 40, top: 700, size: 132 })

    expect(calls.at(-1)).toEqual({
      method: 'drawSvgPath',
      args: [
        qrPath(encodeQr(PAYLOAD)),
        expect.objectContaining({
          x: 56,
          y: 684,
          scale: 4,
          color: expect.objectContaining({ red: 0, green: 0, blue: 0 }),
        }),
      ],
    })
  })

  it('lays a white square under the code and its quiet zone, filling the given square', () => {
    const { page, calls } = recordingPage()

    drawQr(page, PAYLOAD, { x: 40, top: 700, size: 100 })

    expect(calls[0]).toEqual({
      method: 'drawRectangle',
      args: [
        expect.objectContaining({
          x: 40,
          y: 600,
          width: 100,
          height: 100,
          color: expect.objectContaining({ red: 1, green: 1, blue: 1 }),
        }),
      ],
    })
  })
})
