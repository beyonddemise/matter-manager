import { describe, expect, it } from 'vitest'
import { readCredential } from '../../src/matter/credential.js'
import { PayloadError } from '../../src/matter/payload.js'

/**
 * The reference device, verified in `payload.test.ts` and not to be changed without
 * re-deriving it externally: VID 0xFFF1, PID 0x8000, discriminator 3840, passcode 20202021.
 */
const PAYLOAD = 'MT:Y.K9042C00KA0648G00'
/** The same device's manual pairing codes, derived from the fields above. */
const LONG_CODE = '749701123365521327687'
const SHORT_CODE = '34970112332'

describe('a Matter payload', () => {
  it('keeps the payload and derives the manual code', () => {
    expect(readCredential(PAYLOAD)).toEqual({
      payload: PAYLOAD,
      manualCode: LONG_CODE,
      vendorId: 0xfff1,
      productId: 0x8000,
      discriminator: 3840,
    })
  })

  it('ignores surrounding whitespace, which a paste routinely carries', () => {
    expect(readCredential(`  ${PAYLOAD}\n`).payload).toBe(PAYLOAD)
  })

  it('sends a lower-case scheme to the payload decoder rather than calling it a manual code', () => {
    // A typed `mt:` is a payload with a typo. Classifying it as "not a payload" would send the
    // user off to count digits; the decoder's own message says exactly which prefix is wanted.
    expect(() => readCredential('mt:Y.K9042C00KA0648G00')).toThrow(/must begin with "MT:"/)
  })

  it('refuses a payload that is not valid Base38', () => {
    expect(() => readCredential('MT:Y.K9042C00KA0648G0$')).toThrow(PayloadError)
  })
})

describe('a manual pairing code', () => {
  it('reads the 21-digit form, which carries vendor and product', () => {
    expect(readCredential(LONG_CODE)).toEqual({
      manualCode: LONG_CODE,
      vendorId: 0xfff1,
      productId: 0x8000,
    })
  })

  it('reads the 11-digit form, which carries neither', () => {
    expect(readCredential(SHORT_CODE)).toEqual({ manualCode: SHORT_CODE })
  })

  it('never yields a payload, however complete the code is', () => {
    // The load-bearing assertion of this file. A manual code carries the top four bits of the
    // discriminator; the other eight are unrecoverable. A payload reconstructed by guessing
    // them would encode cleanly and produce a QR code that silently fails to commission,
    // which is the worst thing a catalogue like this could hand back.
    expect(readCredential(LONG_CODE)).not.toHaveProperty('payload')
    expect(readCredential(LONG_CODE)).not.toHaveProperty('discriminator')
    expect(readCredential(SHORT_CODE)).not.toHaveProperty('vendorId')
  })

  it('accepts the separators a label prints and stores the digits', () => {
    expect(readCredential('3497-011-2332').manualCode).toBe(SHORT_CODE)
    expect(readCredential('3497 011 2332').manualCode).toBe(SHORT_CODE)
  })

  it('refuses a code whose check digit does not match', () => {
    // `34970112332` with the last digit changed: still 11 digits, still all digits.
    expect(() => readCredential('34970112331')).toThrow(/check digit/i)
  })

  it('refuses a run of digits that is not a code length', () => {
    expect(() => readCredential('1234567')).toThrow(/11 or 21 digits/)
  })
})

describe('neither form', () => {
  it('names both things the text was not', () => {
    const message = messageFrom(() => readCredential('kitchen lamp'))
    expect(message).toMatch(/MT:/)
    expect(message).toMatch(/manual pairing code/)
  })

  it('asks for a code rather than complaining about a format when the field is empty', () => {
    expect(() => readCredential('   ')).toThrow(/Enter the setup code/)
  })

  it('throws PayloadError so a caller can tell input from a bug', () => {
    expect(() => readCredential('kitchen lamp')).toThrow(PayloadError)
  })
})

describe('secrecy', () => {
  it('never echoes the input, which encodes the passcode', () => {
    // The payload body and the code digits both encode the setup passcode, so a message that
    // quoted the input would put it in a log. Every module in `matter/` holds this line; a
    // new entry point is exactly where it gets forgotten.
    const cases = [
      'MT:Y.K9042C00KA0648G0$', // valid-looking payload, invalid Base38
      '34970112331', // real-looking code, wrong check digit
      '749701123365521327680', // 21 digits, wrong check digit
    ]

    for (const input of cases) {
      const message = messageFrom(() => readCredential(input))
      expect(message).not.toContain(input)
      expect(message).not.toContain(input.slice(3))
    }
  })
})

/** Runs `fn`, requires it to throw, and returns the message. */
function messageFrom(fn: () => unknown): string {
  try {
    fn()
  } catch (error) {
    return (error as Error).message
  }
  throw new Error('expected the call to throw, but it returned')
}
