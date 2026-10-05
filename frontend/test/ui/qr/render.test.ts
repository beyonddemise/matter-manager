import { describe, expect, it } from 'vitest'
import { encodeQr } from '../../../src/ui/qr/encode.js'
import { qrPath } from '../../../src/ui/qr/render.js'

/** Paints a `qrPath` string back onto a grid, so the test checks what the path draws. */
function paint(path: string, size: number): boolean[][] {
  const grid = Array.from({ length: size }, () => new Array<boolean>(size).fill(false))
  for (const [, x, y, width, back] of path.matchAll(/M(\d+) (\d+)h(\d+)v1h-(\d+)z/g)) {
    expect(back).toBe(width)
    for (let column = Number(x); column < Number(x) + Number(width); column += 1) {
      const row = grid[Number(y)] as boolean[]
      expect(row[column]).toBe(false)
      row[column] = true
    }
  }
  return grid
}

describe('qrPath', () => {
  it.each(['L', 'M', 'Q', 'H'] as const)('draws exactly the dark modules at level %s', (level) => {
    const matrix = encodeQr('MT:Y.K9042C00KA0648G00', level)

    const painted = paint(qrPath(matrix), matrix.size)

    for (let row = 0; row < matrix.size; row += 1) {
      for (let column = 0; column < matrix.size; column += 1) {
        expect(painted[row]?.[column], `row ${row}, column ${column}`).toBe(
          matrix.isDark(row, column),
        )
      }
    }
  })

  it('is nothing but run rectangles', () => {
    const path = qrPath(encodeQr('MT:Y.K9042C00KA0648G00'))

    expect(path.replace(/M\d+ \d+h\d+v1h-\d+z/g, '')).toBe('')
  })
})
