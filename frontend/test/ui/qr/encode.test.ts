import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { type ErrorCorrection, encodeQr, type QrMatrix } from '../../../src/ui/qr/encode.js'

/** One case from `fixtures/python-qrcode.json`; see `fixtures/generate.py` for its origin. */
interface OracleCase {
  payload: string
  ecl: ErrorCorrection
  version: number
  mask: number
  rows: string[]
}

const fixture = (name: string): string =>
  readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8')

const oracle = JSON.parse(fixture('python-qrcode.json')) as OracleCase[]

/** The symbol as rows of `1` (dark) and `0` (light), the fixtures' notation. */
function rowsOf(matrix: QrMatrix): string[] {
  return Array.from({ length: matrix.size }, (_, row) =>
    Array.from({ length: matrix.size }, (_, column) =>
      matrix.isDark(row, column) ? '1' : '0',
    ).join(''),
  )
}

describe('encodeQr', () => {
  // The test that matters most: a real manufacturer's label, sampled from its PNG. Matching
  // python-qrcode is only the means; this is the end.
  it('reproduces the label of the Matter test device module for module', () => {
    const label = fixture('label-20202021-3840.txt').trim().split('\n')

    const matrix = encodeQr('MT:Y.K9042C00KA0648G00')

    expect(matrix).toMatchObject({ version: 2, errorCorrection: 'M', mask: 5, size: 25 })
    expect(rowsOf(matrix)).toEqual(label)
  })

  it.each(oracle.map((c) => [c.ecl, c.payload.length, c] as const))(
    'matches python-qrcode at level %s for %i characters',
    (_level, _length, expected) => {
      const matrix = encodeQr(expected.payload, expected.ecl)

      expect({ version: matrix.version, mask: matrix.mask }).toEqual({
        version: expected.version,
        mask: expected.mask,
      })
      expect(rowsOf(matrix)).toEqual(expected.rows)
    },
  )

  it('defaults to level M, which the specification recommends', () => {
    expect(encodeQr('MT:Y.K9042C00KA0648G00').errorCorrection).toBe('M')
  })

  it('treats positions outside the symbol as light', () => {
    const matrix = encodeQr('MT:Y.K9042C00KA0648G00')

    expect(matrix.isDark(-1, 0)).toBe(false)
    expect(matrix.isDark(0, matrix.size)).toBe(false)
  })

  // Lower case is not Base-38 and has no place in alphanumeric mode. Refusing it is the
  // alternative to silently falling back to another mode and producing a non-conformant code.
  it('refuses a character outside the alphanumeric set without echoing the payload', () => {
    expect(() => encodeQr('MT:secret')).toThrow(RangeError)
    expect(() => encodeQr('MT:secret')).not.toThrow(/secret/)
  })

  it('refuses a payload longer than version 13 holds', () => {
    expect(() => encodeQr(`MT:${'0'.repeat(400)}`, 'H')).toThrow(/too long/)
  })
})
