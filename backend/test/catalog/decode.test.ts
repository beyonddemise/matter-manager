import { describe, expect, it } from 'vitest'
import { CodeError, decodeCode } from '../../src/catalog/decode.js'

/**
 * The reference vectors are the frontend's own (`frontend/test/domain/matter/payload.test.ts`,
 * `manual-code.test.ts`), copied rather than imported: ADR 0017 keeps the halves apart, and the
 * shared vectors are what keep the two decoders agreeing.
 */
const REFERENCE_QR = 'MT:Y.K9042C00KA0648G00'
const REFERENCE_LONG = '749701123365521327687'
const REFERENCE_SHORT = '34970112332'

/**
 * A real vendor, so the decoder is not only ever tested on test vendors. Produced by the
 * frontend's `encodePayload` and `deriveManualCode` for Aqara (4447) Door and Window Sensor P2
 * (8194), discriminator 3840, passcode 20202021.
 */
const AQARA_QR = 'MT:CUSJ0YJB00KA0648G00'
const AQARA_LONG = '749701123304447081941'

/** The error `decodeCode` throws for this input, or a failure if it throws none. */
function errorFor(input: string): CodeError {
  try {
    decodeCode(input)
  } catch (error) {
    if (error instanceof CodeError) return error
    throw error
  }
  throw new Error('decodeCode accepted the input')
}

describe('decodeCode on the reference vectors', () => {
  it('reads the reference QR payload as test vendor 0xFFF1, product 0x8000', () => {
    expect(decodeCode(REFERENCE_QR)).toEqual({ vendorId: 0xfff1, productId: 0x8000 })
  })

  it('reads the reference 21-digit manual code to the same IDs', () => {
    expect(decodeCode(REFERENCE_LONG)).toEqual({ vendorId: 0xfff1, productId: 0x8000 })
  })

  it('reads a real vendor from a QR payload and from its manual code alike', () => {
    expect(decodeCode(AQARA_QR)).toEqual({ vendorId: 4447, productId: 8194 })
    expect(decodeCode(AQARA_LONG)).toEqual({ vendorId: 4447, productId: 8194 })
  })

  it('answers no-ids for the 11-digit manual code, which is valid and names no product', () => {
    expect(errorFor(REFERENCE_SHORT).kind).toBe('no-ids')
  })
})

describe('decodeCode on what people actually send', () => {
  it.each([
    ['surrounding whitespace on a QR payload', `  ${AQARA_QR}\n`],
    ['surrounding whitespace on a manual code', ` ${AQARA_LONG} `],
    ['hyphenated digit groups', '7497-011-2330-4447-0819-41'],
    ['spaced digit groups', '7497 011 2330 4447 0819 41'],
  ])('tolerates %s', (_case, input) => {
    expect(decodeCode(input)).toEqual({ vendorId: 4447, productId: 8194 })
  })

  it('refuses a lower-case prefix, as the frontend decoder does', () => {
    // Base-38 has no lower-case letters, so `mt:` is a payload typed by hand. Accepting it here
    // would make the backend more lenient than the code the browser could ever have stored.
    expect(errorFor(`mt:${AQARA_QR.slice(3)}`).kind).toBe('malformed')
  })
})

describe('decodeCode on malformed input', () => {
  it.each([
    ['an empty string', ''],
    ['only whitespace', '   '],
    ['the bare prefix', 'MT:'],
    ['a payload too short for the fixed part', 'MT:Y.K90'],
    ['a character outside Base-38', 'MT:Y.K9042C00KA0648G0$'],
    ['a lower-case letter in the body', 'MT:y.K9042C00KA0648G00'],
    ['a trailing chunk of 3 characters', 'MT:Y.K9042C00KA0648G'],
    ['a chunk above its byte range', 'MT:.....'],
    ['the reserved padding bits set', 'MT:Y.K9042C00KA0640A30'],
    ['a wrong check digit', '749701123304447081942'],
    ['a 12-digit number', '349701123321'],
    ['a leading 8, a format this does not know', '84970112331'],
    ['a long code whose leading digit says short', '349701123365521327683'],
    ['a URL', 'https://example.com/MT:Y.K9042C00KA0648G00'],
    ['something far longer than any code', `MT:${'0'.repeat(10_000)}`],
  ])('refuses %s', (_case, input) => {
    expect(errorFor(input).kind).toBe('malformed')
  })

  it.each([
    `${REFERENCE_QR.slice(0, -1)}$`,
    'MT:Y.K9042C00KA0648G',
    REFERENCE_SHORT,
    '749701123304447081942',
    `MT:${'0'.repeat(10_000)}`,
  ])('never puts the code into an error message (%#)', (input) => {
    const { message } = errorFor(input)
    expect(message).not.toContain(input.trim())
    expect(message).not.toContain('MT:')
    expect(message).not.toMatch(/\d{5,}/)
  })
})
