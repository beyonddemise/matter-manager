import { describe, expect, it } from 'vitest'
import { decodeBase38 } from '../../src/matter/base38.js'
import { deriveManualCode, parseManualCode } from '../../src/matter/manual-code.js'
import { decodePayload, encodePayload } from '../../src/matter/payload.js'
import { verhoeffCheckDigit } from '../../src/matter/verhoeff.js'

/**
 * The setup passcode is the one secret this codebase handles. Several modules document it as
 * such — and then every one of them had an error path that echoed it back.
 *
 * Error messages are the easiest place for a secret to escape. They are logged by default,
 * shipped to error trackers, pasted into issues, and read by people who are not thinking
 * about secrecy at the time. Nothing about the leak is visible at the call site, and no
 * ordinary test notices, because the message is only read when something already went wrong.
 *
 * This file exists so the guarantee is enforced rather than remembered. Every path below was
 * verified to fail before the messages were changed.
 */

/** A distinctive value: if it appears in a message, it came from the input. */
const SECRET_OUT_OF_RANGE = 999888777

/** The reference device's real payload and codes, whose bodies encode a real passcode. */
const REFERENCE_PAYLOAD = 'MT:Y.K9042C00KA0648G00'
const REFERENCE_BODY = 'Y.K9042C00KA0648G00'
const MANUAL_BODY = '3497011233'

/** Runs `fn`, requires it to throw, and returns the message. */
const messageFrom = (fn: () => unknown): string => {
  try {
    fn()
  } catch (error) {
    return (error as Error).message
  }
  throw new Error('expected the call to throw, but it returned')
}

describe('error messages never carry the passcode', () => {
  it('does not echo an out-of-range passcode when encoding a payload', () => {
    const message = messageFrom(() =>
      encodePayload({ ...decodePayload(REFERENCE_PAYLOAD), passcode: SECRET_OUT_OF_RANGE }),
    )
    expect(message).not.toContain(String(SECRET_OUT_OF_RANGE))
  })

  it('does not echo an out-of-range passcode when deriving a manual code', () => {
    const message = messageFrom(() =>
      deriveManualCode({ discriminator: 3840, passcode: SECRET_OUT_OF_RANGE }),
    )
    expect(message).not.toContain(String(SECRET_OUT_OF_RANGE))
  })

  it('does not echo the payload body when the prefix is wrong', () => {
    // Reached by a real payload typed with a lower-case prefix - the body is intact and
    // carries the passcode.
    const message = messageFrom(() => decodePayload(`mt:${REFERENCE_BODY}`))
    expect(message).not.toContain(REFERENCE_BODY)
  })

  it('does not echo a manual pairing code that happens to contain a colon', () => {
    // Found by review on #75, and confirmed by running it rather than reasoning about it.
    //
    // The missing-prefix message echoed whatever looked like a URL scheme, on the argument
    // that a scheme is not a secret. It is not - but the pattern matching it accepted digits,
    // so any secret-bearing string with a colon in the first eleven characters was echoed
    // whole. `3497011233:2` returned the entire manual code body.
    //
    // The test above only covers a payload typed with a lower-case `mt:`, which is why this
    // survived: the guarantee was checked for the input the author had in mind rather than for
    // every input that reaches the line.
    const message = messageFrom(() => decodePayload(`${MANUAL_BODY}:2`))
    expect(message).not.toContain(MANUAL_BODY)
  })

  it('does not echo the decoded value when a Base38 chunk overflows', () => {
    // '.....' decodes to 79235167, beyond what three bytes hold. For a Matter payload those
    // three bytes can span the passcode.
    const message = messageFrom(() => decodeBase38('.....'))
    expect(message).not.toContain('79235167')
  })

  it('does not echo the manual code when it contains a stray character', () => {
    const message = messageFrom(() => parseManualCode(`${MANUAL_BODY}a`))
    expect(message).not.toContain(MANUAL_BODY)
  })

  it('does not echo the input when a Verhoeff check digit is asked for non-digits', () => {
    const message = messageFrom(() => verhoeffCheckDigit(`${MANUAL_BODY}a`))
    expect(message).not.toContain(MANUAL_BODY)
  })

  it('does not echo the decoded digit group when it overflows', () => {
    // Digits 2-6 hold the passcode's low 14 bits alongside part of the discriminator.
    const message = messageFrom(() => parseManualCode('09999900009'))
    expect(message).not.toContain('99999')
  })
})

/**
 * A message that leaks nothing by saying nothing would pass every test above. These pin the
 * other half of the bargain: the caller still learns which field was wrong and what is
 * allowed, which is all they needed the value for.
 */
describe('error messages stay useful without the secret', () => {
  it('still names the field and its permitted range', () => {
    const message = messageFrom(() =>
      encodePayload({ ...decodePayload(REFERENCE_PAYLOAD), passcode: SECRET_OUT_OF_RANGE }),
    )
    expect(message).toMatch(/passcode/i)
    expect(message).toContain('134217727')
  })

  it('still identifies the scheme it was given instead of MT:', () => {
    // Restored after an autofix inverted it. A *scheme* is echoed and a body never is, which
    // is the distinction this file is about: `mt:` is what the reader typed instead of `MT:`,
    // and naming it is the difference between "that is not a Matter code" and "you typed the
    // prefix in lower case". The leak the review found was digit-led text matching the scheme
    // pattern, and that is fixed in the pattern rather than by saying less.
    const message = messageFrom(() => decodePayload(`mt:${REFERENCE_BODY}`))
    expect(message).toContain('MT:')
    expect(message).toContain('mt:')
  })

  it('still locates the offending Base38 chunk', () => {
    expect(messageFrom(() => decodeBase38('.....'))).toMatch(/position 0/)
  })

  it('still says which digits of the manual code are out of range', () => {
    expect(messageFrom(() => parseManualCode('09999900009'))).toMatch(/2-6/)
  })
})
