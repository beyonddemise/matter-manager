import { describe, expect, it } from 'vitest'
import { isVerhoeffValid, VerhoeffError, verhoeffCheckDigit } from '../../src/matter/verhoeff.js'

/**
 * The anchor is external, not self-derived.
 *
 * `34970112332` is the manual pairing code for discriminator 3840 / passcode 20202021,
 * verified during design and re-derived from first principles before this file was written:
 * the first ten digits come from the documented field layout, and the final `2` from the
 * Verhoeff algorithm applied to them. If the tables below were transcribed wrongly, this
 * single assertion fails — which is why it is here rather than a round-trip through the
 * implementation's own check digit.
 */
const ANCHOR = '34970112332'
const ANCHOR_BODY = '3497011233'

describe('verhoeffCheckDigit', () => {
  it('produces the check digit of the verified anchor', () => {
    expect(verhoeffCheckDigit(ANCHOR_BODY)).toBe(2)
  })

  it('produces a check digit that validates', () => {
    const body = '1234567890'
    expect(isVerhoeffValid(body + verhoeffCheckDigit(body))).toBe(true)
  })

  it('is not simply a constant', () => {
    // A stub returning 2 would satisfy the anchor test alone.
    const digits = new Set(
      ['0', '1', '12', '123', '1234', '99999', '3497011233'].map(verhoeffCheckDigit),
    )
    expect(digits.size).toBeGreaterThan(1)
  })

  it.each([
    ['a letter', '12a45'],
    ['a space', '12 45'],
    ['a sign', '-1245'],
    ['a decimal point', '12.45'],
    ['an empty string', ''],
  ])('rejects %s rather than treating it as zero', (_label, input) => {
    expect(() => verhoeffCheckDigit(input)).toThrow(VerhoeffError)
    expect(() => verhoeffCheckDigit(input)).toThrow(/digit/i)
  })
})

describe('isVerhoeffValid', () => {
  it('accepts the verified anchor', () => {
    expect(isVerhoeffValid(ANCHOR)).toBe(true)
  })

  it('rejects the anchor with a wrong final digit', () => {
    expect(isVerhoeffValid('34970112335')).toBe(false)
  })

  it('returns false rather than throwing for non-digit input', () => {
    // A predicate that throws forces every caller into a try/catch to answer a yes/no
    // question. Malformed input is simply not valid.
    expect(isVerhoeffValid('34970112ab2')).toBe(false)
    expect(isVerhoeffValid('')).toBe(false)
  })
})

/**
 * Catching these two error classes is the entire reason the algorithm exists. A check digit
 * that validated its own output but missed a mistyped digit would be decoration — and would
 * pass every test above.
 */
describe('the error classes Verhoeff exists to catch', () => {
  const cases = [
    ['the short anchor', ANCHOR],
    // Independently derived long form for the same device, vendor 0xFFF1 / product 0x8000.
    ['the long form', '749701123365521327687'],
  ] as const

  it.each(cases)('detects every single-digit substitution in %s', (_label, code) => {
    // Without this, a predicate that always returned false would collect no misses and pass.
    expect(isVerhoeffValid(code)).toBe(true)
    const missed: string[] = []
    for (let i = 0; i < code.length; i++) {
      for (const replacement of '0123456789') {
        if (replacement === code[i]) continue
        const tampered = code.slice(0, i) + replacement + code.slice(i + 1)
        if (isVerhoeffValid(tampered)) missed.push(`position ${i} -> ${replacement}`)
      }
    }
    expect(missed).toEqual([])
  })

  it.each(cases)('detects every adjacent transposition in %s', (_label, code) => {
    expect(isVerhoeffValid(code)).toBe(true)
    const missed: string[] = []
    for (let i = 0; i < code.length - 1; i++) {
      if (code[i] === code[i + 1]) continue // swapping equal digits changes nothing
      const tampered = code.slice(0, i) + code[i + 1] + code[i] + code.slice(i + 2)
      if (isVerhoeffValid(tampered)) missed.push(`positions ${i}/${i + 1}`)
    }
    expect(missed).toEqual([])
  })

  it('actually tampered with something', () => {
    // Guards the two loops above: if the tampering produced the original string, they would
    // report nothing missed while testing nothing. Both counts are fixed by the code length.
    expect(ANCHOR).toHaveLength(11)
    expect('749701123365521327687').toHaveLength(21)
  })
})
