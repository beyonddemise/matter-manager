/**
 * A QR encoder for Matter onboarding payloads, and nothing else.
 *
 * Written here rather than taken from `<wa-qr-code>` because that component cannot produce a
 * conformant Matter code. The Matter Core Specification (R1.4, §5.1.3.2) says the code
 * **SHALL** use alphanumeric encoding, and that is what the Base-38 alphabet was designed
 * for. The encoder inside `<wa-qr-code>` (`@konnorr/qr-creator`) only knows byte mode. Its
 * output scans, but it is not the symbol the specification describes, and it is not the
 * symbol printed on the device.
 *
 * The goal is stronger than "scans": **the code must look like the label on the device**,
 * module for module. Data and error correction alone do not decide that. The mask does too,
 * and ISO/IEC 18004 leaves mask choice to a penalty score that real encoders compute
 * differently. Measured against a real label (`test/fixtures/qr/label-20202021-3840.txt`):
 * python-qrcode picks the label's mask, while Nayuki's qrcodegen and segno pick others. So
 * {@link chooseMask} reproduces python-qrcode's scoring exactly, quirks included, and the
 * tests hold this module to that library's output matrix by matrix.
 *
 * Scope is deliberately narrow:
 * - **Alphanumeric mode only.** Every Matter payload is `MT:` plus Base-38, which sits
 *   inside the alphanumeric set. Anything else is refused rather than encoded differently.
 * - **Versions 1 to 13.** The specification caps a payload at 255 characters, which fits
 *   version 13 even at level H. The tables stop there so that every entry is one the tests
 *   reach.
 *
 * @module
 */

/** The four error-correction levels, in increasing order of redundancy. */
export type ErrorCorrection = 'L' | 'M' | 'Q' | 'H'

/** One encoded symbol. Row and column count from the top-left module, quiet zone excluded. */
export interface QrMatrix {
  /** Modules per side: `version * 4 + 17`. */
  readonly size: number
  readonly version: number
  readonly errorCorrection: ErrorCorrection
  /** The data mask, 0 to 7, as recorded in the symbol's format bits. */
  readonly mask: number
  /** Whether the module at this row and column is dark. */
  isDark(row: number, column: number): boolean
}

/** The QR alphanumeric character set, in code order (ISO/IEC 18004, table 5). */
const ALPHANUMERIC = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ $%*+-./:'

/** The highest version the tables cover. See the module notes for why it is 13. */
const MAX_VERSION = 13

/**
 * Per level, indexed by version (index 0 unused): error-correction codewords in each block,
 * then the number of blocks. ISO/IEC 18004, table 9.
 */
const BLOCKS: Record<ErrorCorrection, { ecc: number[]; count: number[] }> = {
  L: {
    ecc: [0, 7, 10, 15, 20, 26, 18, 20, 24, 30, 18, 20, 24, 26],
    count: [0, 1, 1, 1, 1, 1, 2, 2, 2, 2, 4, 4, 4, 4],
  },
  M: {
    ecc: [0, 10, 16, 26, 18, 24, 16, 18, 22, 22, 26, 30, 22, 22],
    count: [0, 1, 1, 1, 2, 2, 4, 4, 4, 5, 5, 5, 8, 9],
  },
  Q: {
    ecc: [0, 13, 22, 18, 26, 18, 24, 18, 22, 20, 24, 28, 26, 24],
    count: [0, 1, 1, 2, 2, 4, 4, 6, 6, 8, 8, 8, 10, 12],
  },
  H: {
    ecc: [0, 17, 28, 22, 16, 22, 28, 26, 26, 24, 28, 24, 28, 22],
    count: [0, 1, 1, 2, 4, 4, 4, 5, 6, 8, 8, 11, 11, 16],
  },
}

/** The two format bits that name each level. Not in level order, which is easy to miss. */
const FORMAT_BITS: Record<ErrorCorrection, number> = { L: 1, M: 0, Q: 3, H: 2 }

/**
 * Encodes a Matter payload at the smallest version that holds it.
 *
 * @param text the `MT:` string. **A secret**: it encodes the setup passcode, so it never
 *   appears in an error message thrown from here.
 * @param errorCorrection defaults to `M`, the level the specification recommends ("SHOULD
 *   employ level M or higher") and the one real labels use
 * @returns the symbol, with its mask chosen as python-qrcode would choose it
 * @throws RangeError if the text contains a character outside the alphanumeric set, or is
 *   too long for version 13
 */
export function encodeQr(text: string, errorCorrection: ErrorCorrection = 'M'): QrMatrix {
  for (const character of text) {
    if (!ALPHANUMERIC.includes(character)) {
      throw new RangeError('The payload contains a character QR alphanumeric mode cannot encode.')
    }
  }

  const version = smallestVersion(text.length, errorCorrection)
  const codewords = withErrorCorrection(
    dataCodewords(text, version, errorCorrection),
    version,
    errorCorrection,
  )
  const mask = chooseMask(version, errorCorrection, codewords)
  const modules = build(version, errorCorrection, codewords, mask, true)

  return {
    size: modules.length,
    version,
    errorCorrection,
    mask,
    isDark: (row, column) => modules[row]?.[column] === true,
  }
}

/** Characters of alphanumeric data that fit at this version and level. */
function smallestVersion(length: number, level: ErrorCorrection): number {
  for (let version = 1; version <= MAX_VERSION; version += 1) {
    const bits = 4 + countBits(version) + Math.floor(length / 2) * 11 + (length % 2) * 6
    if (bits <= dataCapacity(version, level) * 8) return version
  }
  throw new RangeError('The payload is too long for a Matter QR code.')
}

/** The width of the character-count field, which grows with the version. */
function countBits(version: number): number {
  return version <= 9 ? 9 : 11
}

/** Data codewords available at this version and level: everything not spent on correction. */
function dataCapacity(version: number, level: ErrorCorrection): number {
  const { ecc, count } = BLOCKS[level]
  return Math.floor(rawDataModules(version) / 8) - at(ecc, version) * at(count, version)
}

/**
 * Modules left for data and correction once every function pattern is placed, remainder
 * bits included. The closed form is Nayuki's (qrcodegen, MIT).
 */
function rawDataModules(version: number): number {
  let result = (16 * version + 128) * version + 64
  if (version >= 2) {
    const alignments = Math.floor(version / 7) + 2
    result -= (25 * alignments - 10) * alignments - 55
    if (version >= 7) result -= 36
  }
  return result
}

/** Mode indicator, count, packed characters, terminator and padding, as codewords. */
function dataCodewords(text: string, version: number, level: ErrorCorrection): number[] {
  const bits: number[] = []
  const append = (value: number, length: number): void => {
    for (let index = length - 1; index >= 0; index -= 1) bits.push((value >>> index) & 1)
  }

  append(0b0010, 4)
  append(text.length, countBits(version))
  for (let index = 0; index + 1 < text.length; index += 2) {
    append(
      ALPHANUMERIC.indexOf(text.charAt(index)) * 45 + ALPHANUMERIC.indexOf(text.charAt(index + 1)),
      11,
    )
  }
  if (text.length % 2 === 1) append(ALPHANUMERIC.indexOf(text.charAt(text.length - 1)), 6)

  const capacity = dataCapacity(version, level) * 8
  append(0, Math.min(4, capacity - bits.length))
  append(0, (8 - (bits.length % 8)) % 8)

  const codewords: number[] = []
  for (let index = 0; index < bits.length; index += 8) {
    let value = 0
    for (let bit = 0; bit < 8; bit += 1) value = (value << 1) | at(bits, index + bit)
    codewords.push(value)
  }
  for (let pad = 0xec; codewords.length < capacity / 8; pad ^= 0xec ^ 0x11) codewords.push(pad)
  return codewords
}

/**
 * Splits the data into blocks, appends each block's Reed-Solomon codewords, and interleaves.
 * Short blocks come first. A long block carries one extra data codeword, and the interleave
 * skips that position for the short ones.
 */
function withErrorCorrection(data: number[], version: number, level: ErrorCorrection): number[] {
  const eccLength = at(BLOCKS[level].ecc, version)
  const blockCount = at(BLOCKS[level].count, version)
  const total = Math.floor(rawDataModules(version) / 8)
  const shortCount = blockCount - (total % blockCount)
  const shortData = Math.floor(total / blockCount) - eccLength
  const divisor = reedSolomonDivisor(eccLength)

  const blocks: { data: number[]; ecc: number[] }[] = []
  for (let block = 0, offset = 0; block < blockCount; block += 1) {
    const length = shortData + (block < shortCount ? 0 : 1)
    const slice = data.slice(offset, offset + length)
    offset += length
    blocks.push({ data: slice, ecc: reedSolomonRemainder(slice, divisor) })
  }

  const result: number[] = []
  for (let index = 0; index <= shortData; index += 1) {
    for (const block of blocks) {
      if (index < block.data.length) result.push(at(block.data, index))
    }
  }
  for (let index = 0; index < eccLength; index += 1) {
    for (const block of blocks) result.push(at(block.ecc, index))
  }
  return result
}

/** The generator polynomial of the given degree, highest coefficient omitted. */
function reedSolomonDivisor(degree: number): number[] {
  const result = new Array<number>(degree).fill(0)
  result[degree - 1] = 1
  let root = 1
  for (let term = 0; term < degree; term += 1) {
    for (let index = 0; index < degree; index += 1) {
      result[index] =
        multiply(at(result, index), root) ^ (index + 1 < degree ? at(result, index + 1) : 0)
    }
    root = multiply(root, 0x02)
  }
  return result
}

/** The remainder of the data polynomial divided by the generator: the correction codewords. */
function reedSolomonRemainder(data: number[], divisor: number[]): number[] {
  const result = new Array<number>(divisor.length).fill(0)
  for (const value of data) {
    const factor = value ^ at(result, 0)
    result.shift()
    result.push(0)
    for (let index = 0; index < result.length; index += 1) {
      result[index] = at(result, index) ^ multiply(at(divisor, index), factor)
    }
  }
  return result
}

/** Multiplication in GF(2^8) modulo x^8 + x^4 + x^3 + x^2 + 1. */
function multiply(x: number, y: number): number {
  let product = 0
  for (let bit = 7; bit >= 0; bit -= 1) {
    product = (product << 1) ^ ((product >>> 7) * 0x11d)
    product ^= ((y >>> bit) & 1) * x
  }
  return product
}

/**
 * The mask python-qrcode would choose: the lowest penalty, the first on a tie.
 *
 * Two details decide whether this matches, and both look like mistakes worth fixing. They
 * are not:
 * - Each candidate is scored with its format and version information **blank**, and the
 *   always-dark module light. python-qrcode scores in a "test" layout that leaves them
 *   unwritten. Scoring the finished symbol instead is what Nayuki does, and it is exactly why
 *   Nayuki picks a different mask for the reference label.
 * - The finder-like rule matches the 1:1:3:1:1 run inside the symbol only, with no virtual
 *   quiet zone beyond the edge.
 */
function chooseMask(version: number, level: ErrorCorrection, codewords: number[]): number {
  let best = 0
  let lowest = Number.POSITIVE_INFINITY
  for (let mask = 0; mask < 8; mask += 1) {
    const penalty = penaltyOf(build(version, level, codewords, mask, false))
    if (penalty < lowest) {
      lowest = penalty
      best = mask
    }
  }
  return best
}

/** python-qrcode's `lost_point`: runs, 2×2 blocks, finder-like patterns, dark balance. */
function penaltyOf(modules: boolean[][]): number {
  const size = modules.length
  const dark = (row: number, column: number): boolean => modules[row]?.[column] === true
  let penalty = 0

  // Runs of five or more same-coloured modules, in rows then columns: length minus two each.
  for (const transpose of [false, true]) {
    for (let line = 0; line < size; line += 1) {
      const colourAt = (index: number): boolean =>
        transpose ? dark(index, line) : dark(line, index)
      let run = 1
      for (let index = 1; index <= size; index += 1) {
        if (index < size && colourAt(index) === colourAt(index - 1)) {
          run += 1
        } else {
          if (run >= 5) penalty += run - 2
          run = 1
        }
      }
    }
  }

  // Every 2×2 block of one colour, overlapping blocks counted separately: three each.
  for (let row = 0; row + 1 < size; row += 1) {
    for (let column = 0; column + 1 < size; column += 1) {
      const colour = dark(row, column)
      if (
        dark(row, column + 1) === colour &&
        dark(row + 1, column) === colour &&
        dark(row + 1, column + 1) === colour
      ) {
        penalty += 3
      }
    }
  }

  // 1011101 with four light modules before or after it, wholly inside the symbol: forty each.
  const finderLike = [
    [true, false, true, true, true, false, true, false, false, false, false],
    [false, false, false, false, true, false, true, true, true, false, true],
  ]
  for (const transpose of [false, true]) {
    for (let line = 0; line < size; line += 1) {
      for (let start = 0; start + 10 < size; start += 1) {
        for (const pattern of finderLike) {
          if (
            pattern.every(
              (expected, offset) =>
                (transpose ? dark(start + offset, line) : dark(line, start + offset)) === expected,
            )
          ) {
            penalty += 40
          }
        }
      }
    }
  }

  // Ten for every full five percent the dark share strays from half. Floating point, on
  // purpose, in the same order of operations: an exact boundary must round as it does there.
  const darkCount = modules.reduce((sum, row) => sum + row.filter(Boolean).length, 0)
  penalty += Math.trunc(Math.abs((darkCount / (size * size)) * 100 - 50) / 5) * 10

  return penalty
}

/**
 * Lays out one complete symbol with the given mask.
 *
 * @param withInformation false for the scoring layout described at {@link chooseMask}:
 *   format and version information left light, and the always-dark module with them
 */
function build(
  version: number,
  level: ErrorCorrection,
  codewords: number[],
  mask: number,
  withInformation: boolean,
): boolean[][] {
  const size = version * 4 + 17
  const modules = Array.from({ length: size }, () => new Array<boolean>(size).fill(false))
  const reserved = Array.from({ length: size }, () => new Array<boolean>(size).fill(false))
  const set = (row: number, column: number, dark: boolean): void => {
    ;(modules[row] as boolean[])[column] = dark
    ;(reserved[row] as boolean[])[column] = true
  }

  for (let index = 0; index < size; index += 1) {
    set(6, index, index % 2 === 0)
    set(index, 6, index % 2 === 0)
  }

  for (const [row, column] of [
    [3, 3],
    [3, size - 4],
    [size - 4, 3],
  ] as const) {
    for (let dy = -4; dy <= 4; dy += 1) {
      for (let dx = -4; dx <= 4; dx += 1) {
        const distance = Math.max(Math.abs(dx), Math.abs(dy))
        const y = row + dy
        const x = column + dx
        if (y >= 0 && y < size && x >= 0 && x < size) set(y, x, distance !== 2 && distance !== 4)
      }
    }
  }

  const centres = alignmentCentres(version)
  const last = centres.length - 1
  centres.forEach((row, i) => {
    centres.forEach((column, j) => {
      if ((i === 0 && j === 0) || (i === 0 && j === last) || (i === last && j === 0)) return
      for (let dy = -2; dy <= 2; dy += 1) {
        for (let dx = -2; dx <= 2; dx += 1)
          set(row + dy, column + dx, Math.max(Math.abs(dx), Math.abs(dy)) !== 1)
      }
    })
  })

  // Format information, both copies, and the module beside the bottom-left finder that is
  // always dark. Reserved even when left light, so that data never lands on them.
  const format = formatBits(level, mask)
  const formatBit = (index: number): boolean => withInformation && ((format >>> index) & 1) === 1
  for (let index = 0; index < 6; index += 1) set(index, 8, formatBit(index))
  set(7, 8, formatBit(6))
  set(8, 8, formatBit(7))
  set(8, 7, formatBit(8))
  for (let index = 9; index < 15; index += 1) set(8, 14 - index, formatBit(index))
  for (let index = 0; index < 8; index += 1) set(8, size - 1 - index, formatBit(index))
  for (let index = 8; index < 15; index += 1) set(size - 15 + index, 8, formatBit(index))
  set(size - 8, 8, withInformation)

  if (version >= 7) {
    const bits = versionBits(version)
    for (let index = 0; index < 18; index += 1) {
      const dark = withInformation && ((bits >>> index) & 1) === 1
      const near = Math.floor(index / 3)
      const far = size - 11 + (index % 3)
      set(near, far, dark)
      set(far, near, dark)
    }
  }

  // Data in two-column strips from the right, zigzagging up and down, skipping the vertical
  // timing column. Remainder bits stay light and are masked like everything else.
  let bitIndex = 0
  const totalBits = codewords.length * 8
  for (let right = size - 1; right >= 1; right -= 2) {
    if (right === 6) right = 5
    const upward = ((right + 1) & 2) === 0
    for (let step = 0; step < size; step += 1) {
      const row = upward ? size - 1 - step : step
      for (let offset = 0; offset < 2; offset += 1) {
        const column = right - offset
        if (reserved[row]?.[column] === true) continue
        let dark = false
        if (bitIndex < totalBits) {
          dark = ((at(codewords, bitIndex >>> 3) >>> (7 - (bitIndex & 7))) & 1) === 1
          bitIndex += 1
        }
        ;(modules[row] as boolean[])[column] = dark !== masked(mask, row, column)
      }
    }
  }

  return modules
}

/** Whether the mask inverts this module. ISO/IEC 18004, table 10. */
function masked(mask: number, row: number, column: number): boolean {
  switch (mask) {
    case 0:
      return (row + column) % 2 === 0
    case 1:
      return row % 2 === 0
    case 2:
      return column % 3 === 0
    case 3:
      return (row + column) % 3 === 0
    case 4:
      return (Math.floor(row / 2) + Math.floor(column / 3)) % 2 === 0
    case 5:
      return ((row * column) % 2) + ((row * column) % 3) === 0
    case 6:
      return (((row * column) % 2) + ((row * column) % 3)) % 2 === 0
    default:
      return (((row + column) % 2) + ((row * column) % 3)) % 2 === 0
  }
}

/** Row and column of each alignment pattern centre. Closed form from Nayuki (MIT). */
function alignmentCentres(version: number): number[] {
  if (version === 1) return []
  const count = Math.floor(version / 7) + 2
  const step = Math.ceil((version * 4 + 4) / (count * 2 - 2)) * 2
  const result = [6]
  for (let position = version * 4 + 10; result.length < count; position -= step)
    result.splice(1, 0, position)
  return result
}

/** Level and mask, BCH(15,5)-protected, XOR'd with the fixed pattern so it is never all light. */
function formatBits(level: ErrorCorrection, mask: number): number {
  const data = (FORMAT_BITS[level] << 3) | mask
  let remainder = data
  for (let index = 0; index < 10; index += 1)
    remainder = (remainder << 1) ^ ((remainder >>> 9) * 0x537)
  return ((data << 10) | remainder) ^ 0x5412
}

/** The version number, BCH(18,6)-protected. Only versions 7 and up carry it. */
function versionBits(version: number): number {
  let remainder = version
  for (let index = 0; index < 12; index += 1)
    remainder = (remainder << 1) ^ ((remainder >>> 11) * 0x1f25)
  return (version << 12) | remainder
}

/**
 * An array element that the index arithmetic above guarantees exists.
 *
 * `noUncheckedIndexedAccess` cannot see that guarantee, and an assertion at every one of
 * these reads would bury the algorithm. A miss is a bug in this file, so it throws rather
 * than quietly reading `undefined` as zero.
 */
function at(values: readonly number[], index: number): number {
  const value = values[index]
  if (value === undefined) throw new RangeError('QR encoder index out of range.')
  return value
}
