import { describe, expect, it } from 'vitest'
import { encodeBase38 } from '../../src/matter/base38.js'
import { readCredential } from '../../src/matter/credential.js'
import { deriveManualCode, parseManualCode } from '../../src/matter/manual-code.js'
import {
  type CustomFlow,
  decodePayload,
  encodePayload,
  type OnboardingPayload,
  PAYLOAD_PROBLEMS,
  PayloadError,
  type PayloadProblem,
} from '../../src/matter/payload.js'
import { verhoeffCheckDigit } from '../../src/matter/verhoeff.js'

/**
 * `PayloadError` carries a **code** as well as a sentence, so that a translated interface can
 * say what went wrong in the reader's own language (#75). The sentence stays for a caller with
 * no interface — the API, a log, this file.
 *
 * The last test here is the one that matters most. A code nobody can produce is a case the
 * interface translates and the user never sees, which is L32's mistake in different clothes:
 * a branch that cannot be fed is not implemented. So every member of the union must be
 * reachable from some input, and this is where that is proved.
 */

const REFERENCE = 'MT:Y.K9042C00KA0648G00'
const reference = (): OnboardingPayload => decodePayload(REFERENCE)

/** Appends the Verhoeff check digit, so a chosen body reaches the checks that follow it. */
const withCheckDigit = (body: string): string => body + verhoeffCheckDigit(body)

/** A manual code whose check digit is wrong, built from one that is right. */
const mistyped = (): string => {
  const valid = deriveManualCode({ discriminator: 3840, passcode: 20202021 })
  return valid.slice(0, -1) + String((Number(valid.slice(-1)) + 1) % 10)
}

/**
 * The reference payload with its reserved padding bits set.
 *
 * Built by hand because nothing here will emit one: `encodePayload` writes zeros into that
 * field by construction, so the only way to reach `decodePayload`'s check is to pack the
 * struct directly.
 */
const reservedPaddingSet = (): string => {
  const p = reference()
  const bytes = new Uint8Array(11)
  let offset = 0
  const put = (value: number, length: number): void => {
    for (let i = 0; i < length; i++) {
      if ((BigInt(value) >> BigInt(i)) & 1n) {
        const bit = offset + i
        bytes[bit >> 3] = (bytes[bit >> 3] as number) | (1 << (bit & 7))
      }
    }
    offset += length
  }
  put(p.version, 3)
  put(p.vendorId, 16)
  put(p.productId, 16)
  put(['standard', 'userActionRequired', 'custom', 'reserved'].indexOf(p.customFlow), 2)
  put(p.discovery.raw, 8)
  put(p.discriminator, 12)
  put(p.passcode, 27)
  put(0b1111, 4)
  return `MT:${encodeBase38(bytes)}`
}

/**
 * One input per code, and the behaviour each input is chosen to reach.
 *
 * A single table rather than a test per case plus a separate coverage list: the two would be
 * free to drift, and a code dropped from the list would quietly stop being proved reachable.
 */
const CASES: ReadonlyArray<readonly [PayloadProblem, string, () => unknown]> = [
  ['missingPrefix', 'a payload typed with a lower-case scheme', () => decodePayload('mt:Y.K90')],
  ['emptyPayload', 'nothing after the prefix', () => decodePayload('MT:')],
  ['notBase38', 'a character outside the alphabet', () => decodePayload('MT:Y.K9042C00KA0648G0$')],
  ['payloadTooShort', 'a body too short for the struct', () => decodePayload('MT:Y.K90')],
  [
    'reservedPaddingSet',
    'reserved padding bits that are not zero',
    () => decodePayload(reservedPaddingSet()),
  ],
  [
    'fieldOutOfRange',
    'a field wider than the bits it must occupy',
    () => encodePayload({ ...reference(), version: 99 }),
  ],
  [
    'unknownCommissioningFlow',
    'a flow outside the four the format defines',
    () => encodePayload({ ...reference(), customFlow: 'nope' as CustomFlow }),
  ],
  [
    'inconsistentDiscovery',
    'a named flag contradicting the raw bitmask',
    () => {
      const p = reference()
      return encodePayload({ ...p, discovery: { ...p.discovery, ble: !p.discovery.ble } })
    },
  ],
  ['manualCodeLength', 'neither 11 nor 21 digits', () => parseManualCode('123')],
  ['manualCodeNotDigits', 'a character that is not a digit', () => parseManualCode('1234567890a')],
  ['manualCodeCheckDigit', 'a mistyped code', () => parseManualCode(mistyped())],
  [
    'manualCodeUnknownFormat',
    'a leading digit reserved for a later format',
    () => parseManualCode(withCheckDigit('8000000000')),
  ],
  [
    'manualCodeLengthContradictsFlag',
    'a vendor/product flag the length denies',
    () => parseManualCode(withCheckDigit('4000000000')),
  ],
  [
    'manualCodeGroupOutOfRange',
    'digits 2-6 above the 16 bits they occupy',
    () => parseManualCode(withCheckDigit('0999990000')),
  ],
  [
    'vendorProductNotPaired',
    'a vendor id with no product id',
    () => deriveManualCode({ discriminator: 1, passcode: 1, vendorId: 1 }),
  ],
  ['emptySetupCode', 'an empty field', () => readCredential('   ')],
  ['notASetupCode', 'text that is neither form', () => readCredential('kitchen lamp')],
]

/** Runs `fn`, requires it to throw a `PayloadError`, and returns its code. */
const problemFrom = (fn: () => unknown): PayloadProblem => {
  try {
    fn()
  } catch (error) {
    if (error instanceof PayloadError && error.problem !== undefined) return error.problem
    throw error
  }
  throw new Error('expected the call to throw a PayloadError, but it returned')
}

describe('a payload failure names which failure it is', () => {
  it.each(CASES)('reports %s for %s', (problem, _description, fn) => {
    expect(problemFrom(fn)).toBe(problem)
  })

  it('preserves the message-only constructor for existing callers', () => {
    const error = new PayloadError('fallback')

    expect(error.message).toBe('fallback')
    expect(error.problem).toBeUndefined()
  })

  it('keeps the English sentence, for a caller with no interface', () => {
    // The API, a log and a test all read this. The code is for the interface; the sentence is
    // for everybody else, and #75 removes neither.
    expect(() => readCredential('kitchen lamp')).toThrow(/manual pairing code/i)
  })
})

describe('the union has no unreachable member', () => {
  const reached = new Set(CASES.map(([problem]) => problem))

  it.each(PAYLOAD_PROBLEMS)('produces %s from some input', (problem) => {
    expect(reached.has(problem)).toBe(true)
  })

  it('produces nothing outside the declared union', () => {
    for (const problem of reached) expect(PAYLOAD_PROBLEMS).toContain(problem)
  })
})
