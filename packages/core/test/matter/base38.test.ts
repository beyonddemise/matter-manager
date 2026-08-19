import { describe, expect, it } from 'vitest'
import {
  BASE38_ALPHABET,
  Base38Error,
  decodeBase38,
  encodeBase38,
} from '../../src/matter/base38.js'

/**
 * HOW THESE VECTORS WERE ESTABLISHED (read before changing any expected value)
 * ---------------------------------------------------------------------------
 * A test vector copied from memory or from a blog post is worse than no test: a wrong
 * expectation gets locked in by a green test, and the implementation is then bent to
 * match the error. So the reference payload below was *verified* against two anchors
 * that are independent of any code in this repository:
 *
 *   Anchor 1 - field values. The payload decodes to Vendor ID 0xFFF1, discriminator 3840
 *   and passcode 20202021, which are the documented values of the standard Matter SDK
 *   test device. A wrong Base38 implementation cannot produce all three by coincidence.
 *
 *   Anchor 2 - the manual pairing code. That same discriminator and passcode derive the
 *   documented manual code 34970112332 through a completely different algorithm (short
 *   discriminator + passcode split, no Base38 involved). Two unrelated derivations
 *   agreeing is strong evidence both are right.
 *
 * The verification also CORRECTED an assumption: this payload's Product ID is 0x8000,
 * not the 0x8001 originally assumed. Had that gone unchecked it would have become a
 * permanently-wrong constant guarded by a passing test.
 *
 * If you need to change an expected value here, re-derive it against an external anchor
 * first. Do not adjust the vector to make the implementation pass.
 */

/** The standard Matter SDK test device payload, without its `MT:` prefix. */
const REFERENCE_BODY = 'Y.K9042C00KA0648G00'

/**
 * The 11 bytes REFERENCE_BODY decodes to.
 *
 * 88 bits, which is exactly the QR payload struct: 3 version + 16 vendor + 16 product
 * + 2 custom flow + 8 discovery + 12 discriminator + 27 passcode + 4 padding.
 */
const REFERENCE_BYTES = Uint8Array.from([
  0x88, 0xff, 0x07, 0x00, 0x44, 0x00, 0xe0, 0x4b, 0x84, 0x68, 0x02,
])

describe('BASE38_ALPHABET', () => {
  it('has exactly 38 symbols', () => {
    expect(BASE38_ALPHABET).toHaveLength(38)
  })

  it('contains no duplicate symbols, so decoding is unambiguous', () => {
    expect(new Set(BASE38_ALPHABET).size).toBe(38)
  })

  it('contains no lowercase letters, which a printed label could render ambiguously', () => {
    expect(BASE38_ALPHABET).toBe(BASE38_ALPHABET.toUpperCase())
  })
})

describe('decodeBase38', () => {
  it('decodes the reference device payload to its 11 packed bytes', () => {
    expect(decodeBase38(REFERENCE_BODY)).toEqual(REFERENCE_BYTES)
  })

  it('decodes an empty string to no bytes', () => {
    expect(decodeBase38('')).toEqual(new Uint8Array(0))
  })

  it('decodes a full 5-character chunk to 3 bytes', () => {
    expect(decodeBase38(REFERENCE_BODY.slice(0, 5))).toHaveLength(3)
  })

  it('decodes a trailing 4-character chunk to 2 bytes', () => {
    // 19 characters = three 5-char chunks plus a trailing 4-char chunk.
    expect(decodeBase38(REFERENCE_BODY)).toHaveLength(3 + 3 + 3 + 2)
  })

  it('decodes a trailing 2-character chunk to 1 byte', () => {
    expect(decodeBase38('00')).toEqual(Uint8Array.from([0]))
  })

  it('decodes the highest single byte', () => {
    // 255 = 6*38 + 27 -> least-significant digit first -> alphabet[27], alphabet[6]
    const encoded = `${BASE38_ALPHABET[27]}${BASE38_ALPHABET[6]}`
    expect(decodeBase38(encoded)).toEqual(Uint8Array.from([255]))
  })

  it.each([
    ['lowercase', 'y.k9042c00ka0648g00'],
    ['a space', 'Y.K90 2C00KA0648G00'],
    ['a symbol outside the alphabet', 'Y.K9042C00KA0648G0$'],
    ['a colon, as would survive a bad MT: prefix strip', ':YK9042C00KA0648G00'],
  ])('rejects %s', (_label, input) => {
    expect(() => decodeBase38(input)).toThrow(Base38Error)
  })

  it.each([
    ['1 character', '0'],
    ['3 characters', '000'],
    ['6 characters', '000000'],
  ])('rejects a trailing chunk of %s, which cannot be a whole number of bytes', (_l, input) => {
    expect(() => decodeBase38(input)).toThrow(Base38Error)
  })

  /**
   * Base38 chunks can express more than they should. Five characters reach 38^5-1 =
   * 79,235,167 but must fit 3 bytes (16,777,215). Without a range check those extra bits
   * are silently discarded, so a damaged or hand-typed code decodes to a *different but
   * plausible* device rather than being rejected - which is far worse than an error,
   * because the user gets a QR code that looks fine and commissions nothing.
   */
  it.each([
    ['a 5-character chunk exceeding 3 bytes', '.....'],
    ['a 4-character chunk exceeding 2 bytes', '....'],
    ['a 2-character chunk exceeding 1 byte', '..'],
  ])('rejects %s', (_label, input) => {
    expect(() => decodeBase38(input)).toThrow(Base38Error)
  })
})

describe('encodeBase38', () => {
  it('encodes the reference bytes back to the reference payload', () => {
    expect(encodeBase38(REFERENCE_BYTES)).toBe(REFERENCE_BODY)
  })

  it('encodes no bytes to an empty string', () => {
    expect(encodeBase38(new Uint8Array(0))).toBe('')
  })

  it('pads a chunk so that leading zero bytes survive the round trip', () => {
    // The failure this guards: emitting only significant digits loses leading zeros, so
    // a payload whose first bytes are zero decodes shorter than it was encoded.
    const bytes = Uint8Array.from([0x00, 0x00, 0x01])
    expect(decodeBase38(encodeBase38(bytes))).toEqual(bytes)
  })
})

describe('round trip', () => {
  it.each([
    ['the reference payload', REFERENCE_BYTES],
    ['a single zero byte', Uint8Array.from([0])],
    ['a single maximum byte', Uint8Array.from([255])],
    ['two bytes', Uint8Array.from([0xde, 0xad])],
    ['three bytes at maximum', Uint8Array.from([255, 255, 255])],
    ['a run of zeros', Uint8Array.from([0, 0, 0, 0, 0, 0])],
  ])('is lossless for %s', (_label, bytes) => {
    expect(decodeBase38(encodeBase38(bytes))).toEqual(bytes)
  })

  it('produces only alphabet characters for every possible byte value', () => {
    const all = Uint8Array.from({ length: 256 }, (_, i) => i)
    for (const char of encodeBase38(all)) {
      expect(BASE38_ALPHABET).toContain(char)
    }
  })
})
