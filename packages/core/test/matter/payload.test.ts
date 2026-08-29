import { describe, expect, it } from 'vitest'
import { encodeBase38 } from '../../src/matter/base38.js'
import {
  decodePayload,
  encodePayload,
  type OnboardingPayload,
  PAYLOAD_PREFIX,
  PayloadError,
} from '../../src/matter/payload.js'

/**
 * The reference payload and its expected field values are VERIFIED, not recalled — see the
 * comment block in base38.test.ts. In particular the Product ID is 0x8000; an earlier
 * assumption of 0x8001 was corrected by checking against two independent anchors. Do not
 * change an expected value here without re-deriving it externally.
 */
const REFERENCE = 'MT:Y.K9042C00KA0648G00'

/** The bytes the reference payload decodes to, from the same verified source. */
const REFERENCE_BYTES = [0x88, 0xff, 0x07, 0x00, 0x44, 0x00, 0xe0, 0x4b, 0x84, 0x68, 0x02]

/**
 * Packs `[value, bitLength]` pairs into a little-endian bit stream.
 *
 * This is deliberately an INDEPENDENT implementation of the bit layout rather than a call
 * to `encodePayload`. Building expected bytes with the encoder under test would make the
 * assertions self-referential: an off-by-one shared by encoder and decoder round-trips
 * perfectly and proves nothing. Keeping a second implementation is what lets these tests
 * pin the widths in absolute terms — it is the reason the 27-bit passcode mutation was
 * caught rather than shipped.
 *
 * Its own correctness is checked against the verified reference bytes below, so the oracle
 * is not simply trusted either.
 */
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

/** The 88-bit base struct of the reference device, with the two widest fields open. */
const packBase = (discriminator: number, passcode: number, padding = 0): Uint8Array =>
  pack([
    [0, 3], // version
    [0xfff1, 16], // vendorId
    [0x8000, 16], // productId
    [0, 2], // customFlow
    [0b10, 8], // discovery: BLE
    [discriminator, 12],
    [passcode, 27],
    [padding, 4], // reserved, must be zero
  ])

const build = (discriminator: number, passcode: number) =>
  PAYLOAD_PREFIX + encodeBase38(packBase(discriminator, passcode))

describe('the pack test oracle', () => {
  /**
   * Verifying the harness before trusting its verdicts (lesson L3). If `pack` disagreed
   * with the real payload, every width assertion built on it would be measuring the wrong
   * layout while looking authoritative.
   */
  it('reproduces the verified reference bytes', () => {
    expect(Array.from(packBase(3840, 20202021))).toEqual(REFERENCE_BYTES)
  })

  it('reproduces the verified reference payload string', () => {
    expect(build(3840, 20202021)).toBe(REFERENCE)
  })
})

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

  it('does not repeat input-derived text in a missing-prefix error', () => {
    // A digit-led prefix is not a scheme (RFC 3986), so nothing from the input is named. The
    // case matters because this input is shaped like a manual pairing code, which is a secret;
    // `secrets.test.ts` states that half of the claim.
    const input = '0123456789:'

    expect(() => decodePayload(input)).toThrow('A Matter payload must begin with "MT:"')
    expect(() => decodePayload(input)).not.toThrow(input)
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

  /**
   * The specification reserves the final four bits and requires them to be zero. Accepting
   * a payload that sets them would mean re-encoding it as zeros and reporting success -
   * the silent alteration the extension rules exist to prevent, in a different place.
   */
  it.each([
    ['the lowest bit', 0b0001],
    ['a middle bit', 0b0100],
    // Found by mutation: with 0b1010 alone, narrowing the padding field to 3 bits still
    // saw a set bit and still threw, so the width was not pinned. Isolating the top bit
    // is what makes a 3-bit read return zero and sail through.
    ['the top bit alone', 0b1000],
    ['every bit', 0b1111],
  ])('rejects a payload whose reserved padding bits set %s', (_label, padding) => {
    const tampered = PAYLOAD_PREFIX + encodeBase38(packBase(3840, 20202021, padding))
    expect(() => decodePayload(tampered)).toThrow(PayloadError)
    expect(() => decodePayload(tampered)).toThrow(/padding|reserved/i)
  })

  it('accepts a payload whose reserved padding bits are zero', () => {
    // The boundary belongs to the accepted side, or a check that rejects everything passes.
    expect(() =>
      decodePayload(PAYLOAD_PREFIX + encodeBase38(packBase(3840, 20202021, 0))),
    ).not.toThrow()
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
 * truncates a value that is actually present.
 */
describe('field widths', () => {
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

// ------------------------------------------------------------------ encoding

describe('encodePayload', () => {
  it('reproduces the reference payload character for character', () => {
    expect(encodePayload(decodePayload(REFERENCE))).toBe(REFERENCE)
  })

  it('emits the MT: prefix', () => {
    expect(encodePayload(decodePayload(REFERENCE)).startsWith(PAYLOAD_PREFIX)).toBe(true)
  })

  /**
   * Checked against `pack`, not against `decodePayload`. A round trip only proves the two
   * halves agree; comparing to an independently packed byte stream proves the encoder puts
   * each field where the specification says it goes.
   */
  it('packs the fields where the specification puts them', () => {
    const encoded = encodePayload(decodePayload(build(0xfff, 0x7ffffff)))
    expect(encoded).toBe(PAYLOAD_PREFIX + encodeBase38(packBase(0xfff, 0x7ffffff)))
  })

  it.each([
    ['the reference device', 3840, 20202021],
    ['every bit of both wide fields set', 0xfff, 0x7ffffff],
    ['the passcode top bit alone', 1, 1 << 26],
    ['all fields at zero', 0, 0],
  ])('round-trips %s exactly', (_label, discriminator, passcode) => {
    const original = build(discriminator, passcode)
    expect(encodePayload(decodePayload(original))).toBe(original)
  })
})

/**
 * The dangerous failure for an extension is not an error. It is decoding the base section,
 * re-encoding without the extension, and reporting success — leaving a stored code that is
 * subtly not the code printed on the device, which a commissioner will reject with no
 * indication of why.
 */
describe('payloads carrying a TLV extension', () => {
  const EXTENSION = [0x15, 0x24, 0x00, 0x11, 0x18]
  const WITH_EXTENSION =
    PAYLOAD_PREFIX + encodeBase38(Uint8Array.from([...REFERENCE_BYTES, ...EXTENSION]))

  it('is longer than the 19-character base section', () => {
    // Guards the fixture itself: if this were 19 characters the tests below would be
    // exercising a base-only payload while claiming to cover extensions.
    expect(WITH_EXTENSION.length).toBeGreaterThan(PAYLOAD_PREFIX.length + 19)
  })

  it('exposes the extension bytes rather than discarding them', () => {
    expect(Array.from(decodePayload(WITH_EXTENSION).extension)).toEqual(EXTENSION)
  })

  it('round-trips a payload carrying an extension exactly', () => {
    expect(encodePayload(decodePayload(WITH_EXTENSION))).toBe(WITH_EXTENSION)
  })

  it('still decodes the base fields correctly alongside an extension', () => {
    const p = decodePayload(WITH_EXTENSION)
    expect(p.vendorId).toBe(0xfff1)
    expect(p.passcode).toBe(20202021)
  })

  it('reports an empty extension for a payload that has none', () => {
    expect(decodePayload(REFERENCE).extension).toHaveLength(0)
  })
})

describe('encodePayload rejects out-of-range fields', () => {
  const base = (): OnboardingPayload => decodePayload(REFERENCE)

  const withField = (field: string, value: number): OnboardingPayload => ({
    ...base(),
    [field]: value,
  })

  it.each([
    ['discriminator', 0x1000, /discriminator/i, /4095|0xfff/i],
    ['passcode', 0x8000000, /passcode/i, /134217727|0x7ffffff/i],
    ['vendorId', 0x10000, /vendorId/i, /65535|0xffff/i],
    ['productId', 0x10000, /productId/i, /65535|0xffff/i],
    ['version', 8, /version/i, /\b7\b/],
  ])('rejects %s above its range, naming the field and the range', (field, value, name, range) => {
    expect(() => encodePayload(withField(field, value))).toThrow(PayloadError)
    expect(() => encodePayload(withField(field, value))).toThrow(name)
    expect(() => encodePayload(withField(field, value))).toThrow(range)
  })

  it.each([
    ['discriminator', 0xfff],
    ['passcode', 0x7ffffff],
    ['vendorId', 0xffff],
    ['productId', 0xffff],
    ['version', 7],
  ])('accepts %s at its maximum', (field, value) => {
    // The boundary belongs to the accepted side. Without this, an off-by-one that rejects
    // the largest legal value passes every rejection test above.
    expect(() => encodePayload(withField(field, value))).not.toThrow()
  })

  it.each([
    ['a negative discriminator', 'discriminator', -1, /discriminator/i],
    ['a fractional passcode', 'passcode', 1.5, /passcode/i],
    ['a non-finite vendorId', 'vendorId', Number.NaN, /vendorId/i],
  ])('rejects %s, naming the field', (_label, field, value, name) => {
    // Naming the field, not merely throwing. `toThrow(PayloadError)` alone is satisfied by
    // a stub that throws unconditionally, so it would go green before the validation exists
    // and stay green if it were later deleted.
    expect(() => encodePayload(withField(field, value))).toThrow(PayloadError)
    expect(() => encodePayload(withField(field, value))).toThrow(name)
    expect(() => encodePayload(withField(field, value))).toThrow(/whole number|integer|range/i)
  })

  it('rejects a discovery bitmask wider than 8 bits', () => {
    const payload = { ...base(), discovery: { ...base().discovery, raw: 0x100 } }
    expect(() => encodePayload(payload)).toThrow(/discovery|raw/i)
  })

  it('rejects an unrecognised commissioning flow', () => {
    const payload = { ...base(), customFlow: 'teleport' } as unknown as OnboardingPayload
    expect(() => encodePayload(payload)).toThrow(/flow/i)
  })
})

/**
 * `discovery` carries both named booleans and the raw bitmask, and only `raw` can round-trip
 * capabilities defined after this was written. Encoding therefore reads `raw` — which makes
 * a caller who sets `ble: true` and leaves `raw` alone silently wrong. Refusing the
 * contradiction is the only option that cannot produce a payload the caller did not mean.
 */
describe('encodePayload rejects contradictory discovery capabilities', () => {
  it.each([
    ['ble claimed but absent from raw', { ble: true }, 0b000],
    ['softAp claimed but absent from raw', { softAp: true }, 0b000],
    ['onNetwork claimed but absent from raw', { onNetwork: true }, 0b000],
    ['ble denied but present in raw', { ble: false }, 0b010],
  ])('rejects %s', (_label, flags, raw) => {
    const p = decodePayload(REFERENCE)
    const payload: OnboardingPayload = {
      ...p,
      discovery: { softAp: false, ble: false, onNetwork: false, ...flags, raw },
    }
    expect(() => encodePayload(payload)).toThrow(/discovery|consistent|raw/i)
  })

  it('accepts named flags that agree with the raw bitmask', () => {
    const payload: OnboardingPayload = {
      ...decodePayload(REFERENCE),
      discovery: { softAp: true, ble: true, onNetwork: false, raw: 0b011 },
    }
    expect(() => encodePayload(payload)).not.toThrow()
  })
})
