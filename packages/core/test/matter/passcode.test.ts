import { describe, expect, it } from 'vitest'
import {
  FORBIDDEN_PASSCODES,
  isValidPasscode,
  MAX_PASSCODE,
  MIN_PASSCODE,
  passcodeProblem,
} from '../../src/matter/passcode.js'
import { decodePayload, encodePayload } from '../../src/matter/payload.js'

/**
 * The ten forbidden values, written out independently of the production constant.
 *
 * The rules were verified against `PayloadContents::IsValidSetupPIN` in connectedhomeip, not
 * recalled: a passcode is usable when it is a whole number from 1 to 99999998 and is not one
 * of these. Note what is absent — 99999999 is refused by the maximum rather than by
 * enumeration, so there are eight repeated-digit values here and not nine.
 *
 * Deriving this table from `FORBIDDEN_PASSCODES` would assert only that everything in the
 * list is forbidden, which is true by construction. Worse, `it.each` over a derived empty
 * array generates no test cases at all — the block disappears silently instead of failing,
 * exactly as it did against the stub while this file was being written.
 */
const FORBIDDEN = [
  11111111, 22222222, 33333333, 44444444, 55555555, 66666666, 77777777, 88888888, 12345678,
  87654321,
] as const

describe('the forbidden list', () => {
  it('holds exactly the ten values the specification enumerates', () => {
    // Pinned as a set so that adding or removing one is a deliberate act with a failing test,
    // rather than a quiet edit to a literal nobody re-checks.
    expect([...FORBIDDEN_PASSCODES].sort((a, b) => a - b)).toEqual(
      [...FORBIDDEN].sort((a, b) => a - b),
    )
  })

  it('does not contain 99999999, which the range excludes instead', () => {
    expect(FORBIDDEN_PASSCODES.has(99999999)).toBe(false)
    expect(isValidPasscode(99999999)).toBe(false)
    expect(passcodeProblem(99999999)).toBe('outOfRange')
  })

  it('bounds the usable range at 1 and 99999998', () => {
    expect(MIN_PASSCODE).toBe(1)
    expect(MAX_PASSCODE).toBe(99999998)
  })
})

describe('passcodeProblem rejects unusable passcodes', () => {
  it('rejects zero, which marks an undefined passcode', () => {
    expect(passcodeProblem(0)).toBe('outOfRange')
  })

  it.each(FORBIDDEN.map((p) => [p]))('rejects the trivial passcode %i', (value) => {
    expect(passcodeProblem(value as number)).toBe('forbidden')
  })

  it('checked all ten of them', () => {
    // `it.each` over an empty array silently generates nothing. This asserts the table above
    // is the size it claims to be, so the block cannot quietly stop testing anything.
    expect(FORBIDDEN).toHaveLength(10)
    expect(new Set(FORBIDDEN).size).toBe(10)
  })

  it.each([
    ['one above the maximum', 99999999],
    ['far above the maximum', 134217727],
    ['above 27 bits', 134217728],
    // A negative passcode is a whole number; it is simply outside the range. Reporting it as
    // "not a whole number" would be a false statement about -1, and this test originally
    // made exactly that mistake by grouping every bad input together.
    ['a negative passcode', -1],
  ])('rejects %s', (_label, value) => {
    expect(passcodeProblem(value)).toBe('outOfRange')
  })

  it.each([
    ['a fractional passcode', 1.5],
    ['not a number', Number.NaN],
    ['infinity', Number.POSITIVE_INFINITY],
  ])('rejects %s', (_label, value) => {
    expect(passcodeProblem(value)).toBe('notAWholeNumber')
  })
})

describe('passcodeProblem accepts usable passcodes', () => {
  it('accepts the reference device', () => {
    // If this ever fails, the rules are wrong rather than the device: 20202021 is the
    // passcode of the standard test payload used throughout this package.
    expect(passcodeProblem(20202021)).toBeNull()
  })

  it.each([
    ['the minimum', 1],
    ['the maximum', 99999998],
  ])('accepts %s, because the boundary belongs to the accepted side', (_label, value) => {
    expect(passcodeProblem(value)).toBeNull()
  })

  /**
   * The forbidden values are refused by equality, not by a pattern or a range. Neighbours
   * must stay usable, or a check written as "any run of repeated digits" would pass every
   * rejection test above while quietly refusing legitimate devices.
   */
  it.each([
    [11111110],
    [11111112],
    [12345677],
    [12345679],
    [87654320],
    [87654322],
    [88888887],
    [88888889],
  ])('accepts %i, a neighbour of a forbidden value', (value) => {
    expect(passcodeProblem(value)).toBeNull()
  })
})

describe('isValidPasscode', () => {
  it('agrees with passcodeProblem on every case that matters', () => {
    const cases = [0, 1, 20202021, 99999998, 99999999, 134217728, -1, 1.5, ...FORBIDDEN]
    for (const value of cases) {
      expect(isValidPasscode(value)).toBe(passcodeProblem(value) === null)
    }
  })

  it('is not simply constant', () => {
    // Guards the test above, which a predicate returning a fixed value could satisfy only if
    // passcodeProblem were equally broken - but both being stubbed is exactly the case worth
    // excluding.
    expect(isValidPasscode(20202021)).toBe(true)
    expect(isValidPasscode(0)).toBe(false)
  })
})

/**
 * The story's scenario end to end: a scanned code whose passcode a compliant device may not
 * have is reported invalid, while the code itself still decodes.
 *
 * That second half is the point of the split. The payload is read faithfully, so the
 * application can show the user exactly what is on the label - which is what they need in
 * order to understand the rejection, or to take it up with whoever sold them the device.
 */
describe('judging a scanned payload', () => {
  const payloadWithPasscode = (passcode: number): string =>
    encodePayload({
      version: 0,
      vendorId: 0xfff1,
      productId: 0x8000,
      customFlow: 'standard',
      discovery: { softAp: false, ble: true, onNetwork: false, raw: 0b10 },
      discriminator: 3840,
      passcode,
      extension: new Uint8Array(0),
    })

  it.each([[0], [11111111], [12345678], [87654321]])(
    'reports a scanned payload carrying passcode %i as unusable',
    (passcode) => {
      const decoded = decodePayload(payloadWithPasscode(passcode))
      expect(decoded.passcode).toBe(passcode)
      expect(isValidPasscode(decoded.passcode)).toBe(false)
    },
  )

  it('still decodes such a payload rather than refusing it', () => {
    // The diagnosis has to survive: refusing to decode would leave the application unable to
    // tell the user what their label actually says.
    const decoded = decodePayload(payloadWithPasscode(11111111))
    expect(decoded.vendorId).toBe(0xfff1)
    expect(decoded.discriminator).toBe(3840)
  })

  it('reports the reference device as usable', () => {
    // The negative cases above would all pass against a predicate that rejected everything.
    const decoded = decodePayload('MT:Y.K9042C00KA0648G00')
    expect(isValidPasscode(decoded.passcode)).toBe(true)
  })
})
