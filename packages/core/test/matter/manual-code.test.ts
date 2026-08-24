import { describe, expect, it } from 'vitest'
import { deriveManualCode, parseManualCode } from '../../src/matter/manual-code.js'
import { PayloadError } from '../../src/matter/payload.js'
import { verhoeffCheckDigit } from '../../src/matter/verhoeff.js'

/**
 * `34970112332` is a VERIFIED anchor for discriminator 3840 / passcode 20202021. It was
 * derived independently of this implementation, digit group by digit group, from the
 * documented layout plus a Verhoeff check digit. Do not change it to match code.
 *
 * The long form for the same device with vendor 0xFFF1 and product 0x8000 was derived the
 * same way. Its first ten digits differ from the short form only in the leading digit, which
 * carries the vendor/product-present flag - so the anchored portion of the layout covers it.
 */
const SHORT = '34970112332'
const LONG = '749701123365521327687'

const DISCRIMINATOR = 3840
const PASSCODE = 20202021
const VENDOR_ID = 0xfff1
const PRODUCT_ID = 0x8000

describe('deriveManualCode', () => {
  it('derives the verified 11-digit code', () => {
    expect(deriveManualCode({ discriminator: DISCRIMINATOR, passcode: PASSCODE })).toBe(SHORT)
  })

  it('derives the 21-digit code when vendor and product are supplied', () => {
    expect(
      deriveManualCode({
        discriminator: DISCRIMINATOR,
        passcode: PASSCODE,
        vendorId: VENDOR_ID,
        productId: PRODUCT_ID,
      }),
    ).toBe(LONG)
  })

  it('produces only digits', () => {
    expect(deriveManualCode({ discriminator: DISCRIMINATOR, passcode: PASSCODE })).toMatch(/^\d+$/)
  })

  /**
   * The manual code carries only the top four bits of the twelve-bit discriminator. Every
   * discriminator sharing those four bits therefore yields the same code, which is correct
   * and worth pinning: an implementation that used all twelve bits would pass the anchor
   * test whenever the lower eight happened to be zero - as they are in 3840.
   */
  it.each([
    [3840, '34970112332'],
    [3841, '34970112332'],
    [4095, '34970112332'],
  ])('uses only the top four bits of discriminator %i', (discriminator, expected) => {
    expect(deriveManualCode({ discriminator, passcode: PASSCODE })).toBe(expected)
  })

  /**
   * Boundary vectors, each derived independently of this implementation.
   *
   * Found by mutation: the verified anchor alone left two defects undetectable. Its low
   * passcode group is 549, so masking 13 bits instead of 14 gives the same value; and its
   * digit group 2-6 is already five digits, so the zero-padding width is never exercised.
   * Both are the M1-1 passcode bug in a new costume — a real vector pins a field only where
   * the value happens to reach the boundary.
   */
  it.each([
    ['bit 13 of the low passcode group set', 0x000, 8193, '00819300009'],
    ['digit group 2-6 needing zero padding', 0x000, 1, '00000100007'],
    ['digit group 7-10 needing zero padding', 0x000, 16383, '01638300003'],
    ['a passcode at its 27-bit maximum', 0xf00, 134217727, '36553581917'],
    ['every field at zero', 0x000, 0, '00000000005'],
  ])('derives the code for %s', (_label, discriminator, passcode, expected) => {
    expect(deriveManualCode({ discriminator, passcode })).toBe(expected)
  })

  it.each([
    ['00819300009', 8193],
    ['00000100007', 1],
    ['01638300003', 16383],
    ['36553581917', 134217727],
    ['00000000005', 0],
  ])('parses %s back to its passcode', (code, passcode) => {
    expect(parseManualCode(code).passcode).toBe(passcode)
  })

  it('always emits exactly 11 digits for the short form', () => {
    // A padding width that is one too small produces a shorter code that still parses as
    // digits, so the length is asserted directly rather than inferred.
    for (const passcode of [0, 1, 8193, 16383, 20202021, 134217727]) {
      expect(deriveManualCode({ discriminator: 0, passcode })).toHaveLength(11)
    }
  })

  it('always emits exactly 21 digits for the long form', () => {
    const pairs: ReadonlyArray<readonly [number, number]> = [
      [0, 0],
      [1, 1],
      [0xfff1, 0x8000],
      [0xffff, 0xffff],
    ]
    for (const [vendorId, productId] of pairs) {
      expect(deriveManualCode({ discriminator: 0, passcode: 1, vendorId, productId })).toHaveLength(
        21,
      )
    }
  })

  it('distinguishes discriminators that differ in their top four bits', () => {
    const a = deriveManualCode({ discriminator: 0x000, passcode: PASSCODE })
    const b = deriveManualCode({ discriminator: 0xf00, passcode: PASSCODE })
    expect(a).not.toBe(b)
  })
})

describe('deriveManualCode rejects unusable input', () => {
  it.each([
    [
      'a discriminator above 12 bits',
      { discriminator: 0x1000, passcode: PASSCODE },
      /discriminator/i,
    ],
    ['a passcode above 27 bits', { discriminator: 0, passcode: 0x8000000 }, /passcode/i],
    ['a negative passcode', { discriminator: 0, passcode: -1 }, /passcode/i],
    ['a fractional discriminator', { discriminator: 1.5, passcode: PASSCODE }, /discriminator/i],
    [
      'a vendor id above 16 bits',
      { discriminator: 0, passcode: PASSCODE, vendorId: 0x10000, productId: 1 },
      /vendorId/i,
    ],
  ])('rejects %s, naming the field', (_label, input, name) => {
    expect(() => deriveManualCode(input)).toThrow(PayloadError)
    expect(() => deriveManualCode(input)).toThrow(name)
  })

  it.each([
    ['a vendor id without a product id', { vendorId: VENDOR_ID }],
    ['a product id without a vendor id', { productId: PRODUCT_ID }],
  ])('rejects %s rather than emitting a half-populated long code', (_label, extra) => {
    const input = { discriminator: DISCRIMINATOR, passcode: PASSCODE, ...extra }
    expect(() => deriveManualCode(input)).toThrow(PayloadError)
    expect(() => deriveManualCode(input)).toThrow(/both|together|vendorId|productId/i)
  })
})

describe('parseManualCode', () => {
  it('recovers the passcode from the short form', () => {
    expect(parseManualCode(SHORT).passcode).toBe(PASSCODE)
  })

  /**
   * Named `shortDiscriminator`, not `discriminator`, because that is all the code contains.
   * Reporting it as a twelve-bit discriminator would be wrong by a factor of 256 and would
   * look entirely plausible.
   */
  it('recovers the short discriminator, not a full one', () => {
    const parsed = parseManualCode(SHORT)
    expect(parsed.shortDiscriminator).toBe(DISCRIMINATOR >> 8)
    expect(parsed).not.toHaveProperty('discriminator')
  })

  it('reports no vendor or product for the short form', () => {
    const parsed = parseManualCode(SHORT)
    expect(parsed.vendorId).toBeUndefined()
    expect(parsed.productId).toBeUndefined()
  })

  it('recovers vendor and product ids from the long form', () => {
    const parsed = parseManualCode(LONG)
    expect(parsed.vendorId).toBe(VENDOR_ID)
    expect(parsed.productId).toBe(PRODUCT_ID)
  })

  it('recovers the passcode and discriminator from the long form too', () => {
    const parsed = parseManualCode(LONG)
    expect(parsed.passcode).toBe(PASSCODE)
    expect(parsed.shortDiscriminator).toBe(DISCRIMINATOR >> 8)
  })

  it.each([
    ['spaces', '3497 011 2332'],
    ['hyphens', '3497-011-2332'],
  ])('accepts a code separated by %s, as printed on labels', (_label, input) => {
    expect(parseManualCode(input).passcode).toBe(PASSCODE)
  })
})

describe('parseManualCode rejects malformed input', () => {
  it('reports a check digit failure by name', () => {
    expect(() => parseManualCode('34970112335')).toThrow(PayloadError)
    expect(() => parseManualCode('34970112335')).toThrow(/check digit/i)
  })

  it('accepts the correct check digit', () => {
    // The boundary belongs to the accepted side, or a parser that rejects everything passes.
    expect(() => parseManualCode(SHORT)).not.toThrow()
  })

  it.each([
    ['too few digits', '3497011233'],
    ['too many digits', '349701123321'],
    ['fifteen digits', '349701123300000'],
  ])('rejects a code of the wrong length (%s), naming the accepted lengths', (_label, input) => {
    expect(() => parseManualCode(input)).toThrow(PayloadError)
    expect(() => parseManualCode(input)).toThrow(/11|21/)
  })

  it.each([
    ['letters', '3497011233a', /digit/i],
    ['an empty string', '', /11|21|empty/i],
  ])('rejects %s, saying why', (_label, input, reason) => {
    // Asserting the reason, not merely that something threw: `toThrow(PayloadError)` alone
    // is satisfied by a stub that throws unconditionally, so it proves nothing.
    expect(() => parseManualCode(input)).toThrow(PayloadError)
    expect(() => parseManualCode(input)).toThrow(reason)
  })

  /**
   * The leading digit says whether vendor and product ids follow. A code whose flag disagrees
   * with its length is malformed, and guessing from the length instead would silently read
   * the wrong fields.
   */
  it('rejects an 11-digit code whose flag claims vendor and product follow', () => {
    // Same body as the short anchor but with the flag bit set, re-checked so only the
    // flag/length disagreement can be at fault.
    const body = `7${SHORT.slice(1, 10)}`
    const withValidCheck = body + verhoeffCheckDigit(body)
    expect(() => parseManualCode(withValidCheck)).toThrow(PayloadError)
    expect(() => parseManualCode(withValidCheck)).toThrow(/vendor|product|length|flag/i)
  })

  /**
   * Digits 2-6 encode a 16-bit quantity, so 65535 is the largest value that can legitimately
   * appear there. A larger one is malformed even with a correct check digit — which this code
   * has, so nothing but the range check can reject it. Found by mutation: without this the
   * check could be deleted and every test stayed green.
   */
  it('rejects a code whose digits 2-6 exceed the 16 bits they encode', () => {
    expect(() => parseManualCode('09999900009')).toThrow(PayloadError)
    expect(() => parseManualCode('09999900009')).toThrow(/2-6|16 bits|malformed/i)
  })

  it('accepts the largest legal value in digits 2-6', () => {
    // The boundary belongs to the accepted side, or a check rejecting everything passes.
    expect(() => parseManualCode('06553500004')).not.toThrow()
  })

  /**
   * The first digit holds the vendor/product flag in bit 2 and the discriminator's top two
   * bits in bits 0-1. Bit 3 is not part of the encoding, so a leading 8 or 9 belongs to a
   * later format. Reading it as version 1 silently discards that bit: `8...` parses exactly
   * as `0...` would, yielding a plausible device that is not the one on the label.
   *
   * The reference parser refuses the same values - `if (chunk1 == 8 || chunk1 == 9) return
   * CHIP_ERROR_INVALID_ARGUMENT;` - commented as "invalid for v1 and would indicate new
   * format". Both codes below carry correct check digits, so nothing but this rule can
   * reject them.
   */
  it.each([
    ['8', '84970112331'],
    ['9', '94970112333'],
  ])('rejects an 11-digit code whose leading digit %s is reserved', (_label, code) => {
    expect(() => parseManualCode(code)).toThrow(PayloadError)
    expect(() => parseManualCode(code)).toThrow(/version|reserved|format/i)
  })

  it('rejects a reserved leading digit before complaining about anything else', () => {
    // A 21-digit code led by 8 also disagrees with the vendor/product flag, which is bit 2
    // and clear in 8. The version is the more fundamental fault and must be reported first,
    // or the message sends the reader to the wrong part of the specification.
    expect(() => parseManualCode('897011233655213276873')).toThrow(/version|reserved|format/i)
  })

  it.each([
    ['0', '00000000005'],
    ['3', '34970112332'],
    ['7', '749701123365521327687'],
  ])('accepts leading digit %s, the defined range', (_label, code) => {
    // The boundary belongs to the accepted side: 7 is the largest legal first digit, and a
    // check written as `first >= 7` would pass every rejection test above.
    expect(() => parseManualCode(code)).not.toThrow()
  })

  it('rejects a 21-digit code whose flag says no vendor or product follows', () => {
    // The mirror of the case above. Both directions of the disagreement must be refused;
    // testing only one leaves the parser free to trust the length in the other.
    expect(() => parseManualCode('349701123365521327683')).toThrow(PayloadError)
    expect(() => parseManualCode('349701123365521327683')).toThrow(/vendor|product|length|flag/i)
  })

  it('round-trips every code it accepts', () => {
    for (const code of [SHORT, LONG]) {
      const parsed = parseManualCode(code)
      const rebuilt = deriveManualCode({
        // The full discriminator is unrecoverable, so re-derive from the short one.
        discriminator: parsed.shortDiscriminator << 8,
        passcode: parsed.passcode,
        ...(parsed.vendorId === undefined
          ? {}
          : { vendorId: parsed.vendorId, productId: parsed.productId }),
      })
      expect(rebuilt).toBe(code)
    }
  })
})
