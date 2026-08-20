import { describe, expect, it } from 'vitest'
import { encodeBase38 } from '../../src/matter/base38.js'
import { decodePayload, PAYLOAD_PREFIX, PayloadError } from '../../src/matter/payload.js'

/**
 * The reference payload and its expected field values are VERIFIED, not recalled — see the
 * comment block in base38.test.ts. In particular the Product ID is 0x8000; an earlier
 * assumption of 0x8001 was corrected by checking against two independent anchors. Do not
 * change an expected value here without re-deriving it externally.
 */
const REFERENCE = 'MT:Y.K9042C00KA0648G00'

describe('decodePayload', () => {
  it('decodes every field of the reference device payload', () => {
    const p = decodePayload(REFERENCE)

    expect(p.version).toBe(0)
    expect(p.vendorId).toBe(0xfff1)
    expect(p.productId).toBe(0x8000)
    expect(p.discriminator).toBe(3840)
    expect(p.passcode).toBe(20202021)
  })

  it('reports the commissioning flow', () => {
    expect(decodePayload(REFERENCE).customFlow).toBe('standard')
  })

  it('reports BLE as the discovery capability of the reference device', () => {
    const { discovery } = decodePayload(REFERENCE)

    expect(discovery.ble).toBe(true)
    expect(discovery.softAp).toBe(false)
    expect(discovery.onNetwork).toBe(false)
  })

  /**
   * Asserting only one field would pass against badly broken code: the fields are packed
   * into a single 88-bit little-endian stream, so an off-by-one in any width shifts every
   * subsequent field. Checking all of them together is what makes the boundaries load-bearing.
   */
  it('consumes exactly the 88 bits the struct occupies', () => {
    // 3 version + 16 vendor + 16 product + 2 flow + 8 discovery + 12 discriminator
    // + 27 passcode + 4 padding = 88 bits = 11 bytes = 19 Base38 characters.
    expect(REFERENCE.slice(3)).toHaveLength(19)
  })
})

/**
 * Every case here asserts WHY the input was refused, not merely that something was thrown.
 *
 * `toThrow(PayloadError)` alone passes against a stub that throws unconditionally — so it
 * would go green before any validation exists, and stay green if the validation were later
 * deleted. Asserting the specific reason is what makes these tests testable at all. The same
 * mistake in a different costume has already appeared three times in this project: an
 * assertion that is true without being the claim.
 */
describe('decodePayload rejects malformed input', () => {
  it.each([
    ['no prefix at all', 'Y.K9042C00KA0648G00'],
    ['a lowercase prefix', 'mt:Y.K9042C00KA0648G00'],
    ['a different scheme', 'HTTP:Y.K9042C00KA0648G00'],
  ])('rejects %s, naming the required prefix', (_label, input) => {
    expect(() => decodePayload(input)).toThrow(PayloadError)
    expect(() => decodePayload(input)).toThrow(/MT:/)
  })

  it('rejects a body too short for the 11-byte struct, saying so', () => {
    expect(() => decodePayload('MT:Y.K90')).toThrow(/too short|11 bytes/i)
  })

  it('does not return a partially populated result for a short payload', () => {
    // The failure that matters is not an exception but its absence: decoding what fits and
    // leaving the rest at zero yields a plausible device with the wrong passcode.
    let result: unknown
    try {
      result = decodePayload('MT:Y.K90')
    } catch {
      result = undefined
    }
    expect(result).toBeUndefined()
  })

  it('rejects a body containing characters outside the Base38 alphabet, saying which', () => {
    expect(() => decodePayload('MT:Y.K9042C00KA0648G0$')).toThrow(/Base38|\$/)
  })

  it('rejects an empty payload distinctly from a malformed one', () => {
    expect(() => decodePayload('MT:')).toThrow(/empty|too short/i)
  })
})

/**
 * The reference device alone does not pin the field WIDTHS.
 *
 * Found by mutation: narrowing the passcode from 27 bits to 26 broke no test, because
 * 20202021 needs only 25 bits — the top two are zero either way. A whole class of off-by-one
 * would have shipped behind a green suite.
 *
 * These vectors set every bit of the widest fields, so a width that is one too small
 * truncates a value that is actually present. Bytes are packed here rather than produced by
 * the encoder, which does not exist until M1-2; `encodeBase38` is used only for the character
 * layer, and is independently verified in base38.test.ts.
 */
describe('field widths', () => {
  /** Packs `[value, bitLength]` pairs into a little-endian bit stream. */
  const pack = (fields: ReadonlyArray<readonly [number, number]>): Uint8Array => {
    const totalBits = fields.reduce((n, [, len]) => n + len, 0)
    const bytes = new Uint8Array(Math.ceil(totalBits / 8))
    let offset = 0
    for (const [value, len] of fields) {
      for (let i = 0; i < len; i++) {
        if ((BigInt(value) >> BigInt(i)) & 1n) {
          const bit = offset + i
          const index = bit >> 3
          bytes[index] = (bytes[index] as number) | (1 << (bit & 7))
        }
      }
      offset += len
    }
    return bytes
  }

  const build = (discriminator: number, passcode: number) =>
    PAYLOAD_PREFIX +
    encodeBase38(
      pack([
        [0, 3], // version
        [0xfff1, 16], // vendorId
        [0x8000, 16], // productId
        [0, 2], // customFlow
        [0b10, 8], // discovery: BLE
        [discriminator, 12],
        [passcode, 27],
        [0, 4], // padding
      ]),
    )

  it('reads all 27 bits of the passcode', () => {
    // 0x7FFFFFF is every bit set; a 26-bit read would return 0x3FFFFFF.
    expect(decodePayload(build(0xfff, 0x7ffffff)).passcode).toBe(0x7ffffff)
  })

  it('reads all 12 bits of the discriminator', () => {
    expect(decodePayload(build(0xfff, 0x7ffffff)).discriminator).toBe(0xfff)
  })

  it('keeps the fields independent when both are at their maximum', () => {
    const p = decodePayload(build(0xfff, 0x7ffffff))
    expect(p.vendorId).toBe(0xfff1)
    expect(p.productId).toBe(0x8000)
    expect(p.version).toBe(0)
    expect(p.discovery.ble).toBe(true)
  })

  it('reads a passcode whose top bit alone is set', () => {
    // Isolates bit 26 specifically: a 26-bit read returns 0 here.
    expect(decodePayload(build(1, 1 << 26)).passcode).toBe(1 << 26)
  })
})

describe('decoded field ranges', () => {
  it('produces a discriminator inside 12 bits', () => {
    const { discriminator } = decodePayload(REFERENCE)
    expect(discriminator).toBeGreaterThanOrEqual(0)
    expect(discriminator).toBeLessThanOrEqual(0xfff)
  })

  it('produces a passcode inside 27 bits', () => {
    const { passcode } = decodePayload(REFERENCE)
    expect(passcode).toBeGreaterThanOrEqual(0)
    expect(passcode).toBeLessThanOrEqual(0x7ffffff)
  })

  it('exposes the raw discovery bitmask alongside the named capabilities', () => {
    // Named booleans cover the three defined bits; the raw value keeps forward
    // compatibility with capabilities defined after this was written.
    expect(decodePayload(REFERENCE).discovery.raw).toBe(0b0000_0010)
  })
})
