/**
 * Matter onboarding payload: the contents of a device's commissioning QR code.
 *
 * The text form is `MT:` followed by a Base38-encoded, bit-packed struct. This module turns
 * that string into fields and back again; {@link decodeBase38} handles the character
 * encoding underneath.
 *
 * The base struct is 88 bits, read as a little-endian bit stream in this order:
 *
 * | Field                  | Bits |
 * |------------------------|------|
 * | Version                | 3    |
 * | Vendor ID              | 16   |
 * | Product ID             | 16   |
 * | Custom flow            | 2    |
 * | Discovery capabilities | 8    |
 * | Discriminator          | 12   |
 * | Passcode               | 27   |
 * | Padding                | 4    |
 *
 * An optional TLV extension section may follow, starting at the next byte boundary. Its
 * contents are not interpreted here, but they are carried verbatim so that decoding and
 * re-encoding reproduces the original string exactly.
 *
 * Because the fields share one stream, an off-by-one in any width shifts every later field.
 * The widths live in {@link WIDTH} so the decoder and encoder cannot drift apart, and the
 * tests check them against an independently written bit-packer rather than against each
 * other - two halves that agree can still both be wrong.
 *
 * @module
 */

import { Base38Error, decodeBase38, encodeBase38 } from './base38.js'

/** How commissioning is expected to begin, from the 2-bit custom flow field. */
export type CustomFlow = 'standard' | 'userActionRequired' | 'custom' | 'reserved'

/** Which transports the device can be discovered on, from the 8-bit bitmask. */
export interface DiscoveryCapabilities {
  /** The device hosts a temporary Wi-Fi access point. */
  readonly softAp: boolean
  /** The device is discoverable over Bluetooth Low Energy. */
  readonly ble: boolean
  /** The device is already on an IP network. */
  readonly onNetwork: boolean
  /** The undecoded bitmask, so capabilities defined later are not lost. */
  readonly raw: number
}

/** The decoded contents of a Matter onboarding payload. */
export interface OnboardingPayload {
  readonly version: number
  readonly vendorId: number
  readonly productId: number
  readonly customFlow: CustomFlow
  readonly discovery: DiscoveryCapabilities
  readonly discriminator: number
  /** **Secret.** Never log this, and never send it to a third party. */
  readonly passcode: number
  /**
   * The optional TLV extension section, verbatim and uninterpreted; empty when absent.
   *
   * Kept so that {@link encodePayload} can reproduce the original string. Dropping it would
   * yield a shorter payload that still looks valid, and the user would be left with a stored
   * code that is subtly not the code printed on the device.
   */
  readonly extension: Uint8Array
}

/**
 * Why a string is not a usable Matter setup code.
 *
 * A code rather than a sentence, for the reason `PasscodeProblem` and `RoomPathProblem` already
 * are: these reach a user interface that is translated, and an English string decided in `core`
 * could not be. The wording belongs with the translations; the reason belongs here.
 *
 * One union across the payload, the manual pairing code and the credential reader, because the
 * interface has one field. A person typing into it does not first decide which of the three
 * forms they are attempting, so the failures cannot be told apart by which module produced them.
 *
 * An array rather than a bare type so the set can be walked at run time. That is what lets a
 * test prove every member is reachable from some input — a code nothing can produce is a
 * sentence nobody will read, and it would otherwise look exactly like a working one.
 */
export const PAYLOAD_PROBLEMS = [
  /** The text does not begin with `MT:`. */
  'missingPrefix',
  /** The prefix is there and nothing follows it. */
  'emptyPayload',
  /** The body contains a character outside the Base38 alphabet, or a chunk that overflows. */
  'notBase38',
  /** The body decodes to fewer bytes than the 88-bit struct needs. */
  'payloadTooShort',
  /** The reserved padding bits are not zero, so this is not a payload this version can read. */
  'reservedPaddingSet',
  /** A field does not fit the width it must occupy. Reachable when encoding, not when decoding. */
  'fieldOutOfRange',
  /** The commissioning flow is not one of the four the format defines. */
  'unknownCommissioningFlow',
  /** A named discovery flag contradicts the raw bitmask it is supposed to describe. */
  'inconsistentDiscovery',
  /** A manual pairing code with a length that is neither 11 nor 21 digits. */
  'manualCodeLength',
  /** A manual pairing code containing something that is not a digit or a separator. */
  'manualCodeNotDigits',
  /** The Verhoeff check digit does not match: the code was mistyped or misread. */
  'manualCodeCheckDigit',
  /** The leading digit selects a format this version does not define. */
  'manualCodeUnknownFormat',
  /** The leading digit's vendor/product flag disagrees with how many digits there are. */
  'manualCodeLengthContradictsFlag',
  /** Digits 2-6 decode above the 16 bits they occupy, so the code is malformed. */
  'manualCodeGroupOutOfRange',
  /** A vendor id was supplied without a product id, or the other way round. */
  'vendorProductNotPaired',
  /** The field was left empty. */
  'emptySetupCode',
  /** The text is neither a Matter payload nor a manual pairing code. */
  'notASetupCode',
] as const

/** Why a string is not a usable Matter setup code. See {@link PAYLOAD_PROBLEMS}. */
export type PayloadProblem = (typeof PAYLOAD_PROBLEMS)[number]

/** Thrown when a string is not a usable Matter onboarding payload. */
export class PayloadError extends Error {
  override readonly name = 'PayloadError'
  /**
   * Which failure this is, for an interface that has to say so in the reader's language.
   *
   * The `message` is unchanged and stays the fallback for a caller with no interface: the API,
   * a log, a test. Neither replaces the other.
   */
  /** Absent only for the legacy message-only constructor. */
  readonly problem?: PayloadProblem

  constructor(message: string, options?: ErrorOptions)
  constructor(problem: PayloadProblem, message: string, options?: ErrorOptions)
  constructor(
    problemOrMessage: PayloadProblem | string,
    messageOrOptions?: string | ErrorOptions,
    options?: ErrorOptions,
  ) {
    const hasProblem = typeof messageOrOptions === 'string'
    super(hasProblem ? messageOrOptions : problemOrMessage, hasProblem ? options : messageOrOptions)
    if (hasProblem) this.problem = problemOrMessage as PayloadProblem
  }
}

/** Every Matter onboarding payload begins with this. */
export const PAYLOAD_PREFIX = 'MT:'

/** The packed base struct occupies 88 bits, so exactly 11 bytes. */
const STRUCT_BYTES = 11

/**
 * Field widths in bits, in the order they appear in the stream.
 *
 * Single-sourced deliberately. Held separately, the decoder and encoder could disagree by
 * one bit and still round-trip perfectly, because the error would cancel itself out.
 */
const WIDTH = {
  version: 3,
  vendorId: 16,
  productId: 16,
  customFlow: 2,
  discovery: 8,
  discriminator: 12,
  passcode: 27,
  padding: 4,
} as const

const CUSTOM_FLOWS: readonly CustomFlow[] = ['standard', 'userActionRequired', 'custom', 'reserved']

const DISCOVERY_SOFT_AP = 0b0000_0001
const DISCOVERY_BLE = 0b0000_0010
const DISCOVERY_ON_NETWORK = 0b0000_0100

/** The largest value a field of `width` bits can hold. */
const maxValue = (width: number): number => 2 ** width - 1

/**
 * Reads `length` bits starting at `offset` from a little-endian bit stream.
 *
 * Uses BigInt because the passcode is 27 bits and lands at an offset that can push the
 * intermediate value past the range where JavaScript's bitwise operators are safe — they
 * coerce to 32-bit signed integers, which would silently corrupt the result rather than fail.
 */
function readBits(bytes: Uint8Array, offset: number, length: number): number {
  let value = 0n
  for (let i = 0; i < length; i++) {
    const bit = offset + i
    const byte = bytes[bit >> 3] as number
    if ((byte >> (bit & 7)) & 1) value |= 1n << BigInt(i)
  }
  return Number(value)
}

/** Writes `length` bits of `value` at `offset`. The inverse of {@link readBits}. */
function writeBits(bytes: Uint8Array, offset: number, length: number, value: number): void {
  const bits = BigInt(value)
  for (let i = 0; i < length; i++) {
    if ((bits >> BigInt(i)) & 1n) {
      const bit = offset + i
      const index = bit >> 3
      bytes[index] = (bytes[index] as number) | (1 << (bit & 7))
    }
  }
}

/**
 * Decodes a Matter onboarding payload into its fields.
 *
 * @param text The full payload, including the `MT:` prefix.
 * @returns Every field of the 88-bit struct, plus any TLV extension section verbatim.
 * @throws {PayloadError} If the prefix is missing, the body is not valid Base38, it is too
 *   short to contain the struct, or the reserved padding bits are not zero. Never returns a
 *   partially populated result — a payload decoded halfway would describe a plausible device
 *   with the wrong passcode, which is a worse outcome than an error.
 */
export function decodePayload(text: string): OnboardingPayload {
  if (!text.startsWith(PAYLOAD_PREFIX)) {
    throw new PayloadError('missingPrefix', `A Matter payload must begin with "${PAYLOAD_PREFIX}".`)
  }

  const body = text.slice(PAYLOAD_PREFIX.length)
  if (body.length === 0) {
    throw new PayloadError(
      'emptyPayload',
      'The payload is empty: nothing follows the "MT:" prefix.',
    )
  }

  let bytes: Uint8Array
  try {
    bytes = decodeBase38(body)
  } catch (cause) {
    if (cause instanceof Base38Error) {
      throw new PayloadError(
        'notBase38',
        `The payload body is not valid Base38: ${cause.message}`,
        { cause },
      )
    }
    // Unreachable by construction - decodeBase38 throws only Base38Error - and deliberately
    // kept uncovered rather than removed. Wrapping everything would relabel a genuine bug
    // (a TypeError, say) as a malformed payload, sending the next person to inspect a QR
    // code that was fine.
    throw cause
  }

  if (bytes.length < STRUCT_BYTES) {
    throw new PayloadError(
      'payloadTooShort',
      `The payload is too short: decoded ${bytes.length} bytes, but the struct needs ${STRUCT_BYTES} bytes.`,
    )
  }

  let offset = 0
  const take = (length: number): number => {
    const value = readBits(bytes, offset, length)
    offset += length
    return value
  }

  const version = take(WIDTH.version)
  const vendorId = take(WIDTH.vendorId)
  const productId = take(WIDTH.productId)
  const customFlow = CUSTOM_FLOWS[take(WIDTH.customFlow)] as CustomFlow
  const raw = take(WIDTH.discovery)
  const discriminator = take(WIDTH.discriminator)
  const passcode = take(WIDTH.passcode)
  const padding = take(WIDTH.padding)

  // The specification reserves these bits and requires them to be zero. Accepting a payload
  // that sets them would mean re-encoding it as zeros and reporting success - handing back a
  // code that differs from the one on the device, with nothing to indicate it.
  if (padding !== 0) {
    throw new PayloadError(
      'reservedPaddingSet',
      `The reserved padding bits must be zero; received ${padding}. The payload is malformed or was not a Matter onboarding code.`,
    )
  }

  return {
    version,
    vendorId,
    productId,
    customFlow,
    discovery: {
      softAp: (raw & DISCOVERY_SOFT_AP) !== 0,
      ble: (raw & DISCOVERY_BLE) !== 0,
      onNetwork: (raw & DISCOVERY_ON_NETWORK) !== 0,
      raw,
    },
    discriminator,
    passcode,
    extension: bytes.slice(STRUCT_BYTES),
  }
}

/**
 * Fields whose value must never appear in an error message.
 *
 * Driven by the field name rather than by a flag at each call site, deliberately. A flag is
 * something a future caller can forget, and the failure is silent - the code works, the tests
 * pass, and the passcode quietly ends up in a log. Keying on the name makes the safe
 * behaviour automatic for every call that guards a secret field, including ones not yet
 * written.
 */
const SECRET_FIELDS: ReadonlySet<string> = new Set(['passcode'])

/**
 * Rejects anything that is not a whole number inside the field's width.
 *
 * Exported because the manual pairing code guards the same fields against the same widths.
 * A second copy would be free to drift, and two range checks disagreeing about what a legal
 * discriminator is would be a genuinely confusing bug to chase.
 *
 * The message names the field and its permitted range, and echoes the offending value only
 * when that value is not secret. What went wrong and what is allowed are what a caller needs;
 * repeating the passcode back adds nothing and puts it somewhere it does not belong.
 */
export function requireInRange(name: string, value: number, width: number): number {
  const max = maxValue(width)
  if (!Number.isInteger(value) || value < 0 || value > max) {
    const received = SECRET_FIELDS.has(name)
      ? 'the value supplied is outside it'
      : `received ${value}`
    throw new PayloadError(
      'fieldOutOfRange',
      `${name} must be a whole number between 0 and ${max} (0x${max.toString(16)}); ${received}.`,
    )
  }
  return value
}

/**
 * Checks the named discovery flags against the bitmask they are supposed to describe.
 *
 * Encoding reads `raw`, because only `raw` can carry capabilities defined after this was
 * written. That makes a caller who sets `ble: true` and leaves `raw` alone silently wrong.
 * Refusing the contradiction is the one option that cannot emit a payload nobody meant.
 */
function requireConsistentDiscovery(discovery: DiscoveryCapabilities): number {
  const raw = requireInRange('discovery.raw', discovery.raw, WIDTH.discovery)

  const expected = {
    softAp: (raw & DISCOVERY_SOFT_AP) !== 0,
    ble: (raw & DISCOVERY_BLE) !== 0,
    onNetwork: (raw & DISCOVERY_ON_NETWORK) !== 0,
  }

  for (const [flag, value] of Object.entries(expected)) {
    if (discovery[flag as keyof typeof expected] !== value) {
      throw new PayloadError(
        'inconsistentDiscovery',
        `discovery.${flag} is ${discovery[flag as keyof typeof expected]} but the raw bitmask 0b${raw
          .toString(2)
          .padStart(8, '0')} says ${value}. They must be consistent; encoding follows raw.`,
      )
    }
  }

  return raw
}

/**
 * Encodes payload fields back into their `MT:` text form.
 *
 * The inverse of {@link decodePayload}: decoding a valid payload and re-encoding it returns
 * the original string character for character, extension section included.
 *
 * @param payload The fields to encode.
 * @returns The full payload text, including the `MT:` prefix.
 * @throws {PayloadError} If any field falls outside the width it must occupy, the
 *   commissioning flow is unrecognised, or the named discovery flags contradict the raw
 *   bitmask. Every field is validated before anything is written, so a rejected payload
 *   never produces partial output.
 */
export function encodePayload(payload: OnboardingPayload): string {
  const version = requireInRange('version', payload.version, WIDTH.version)
  const vendorId = requireInRange('vendorId', payload.vendorId, WIDTH.vendorId)
  const productId = requireInRange('productId', payload.productId, WIDTH.productId)
  const discriminator = requireInRange('discriminator', payload.discriminator, WIDTH.discriminator)
  const passcode = requireInRange('passcode', payload.passcode, WIDTH.passcode)
  const discovery = requireConsistentDiscovery(payload.discovery)

  const flow = CUSTOM_FLOWS.indexOf(payload.customFlow)
  if (flow < 0) {
    throw new PayloadError(
      'unknownCommissioningFlow',
      `Unknown commissioning flow ${JSON.stringify(payload.customFlow)}; expected one of ${CUSTOM_FLOWS.join(', ')}.`,
    )
  }

  const extension = payload.extension
  const bytes = new Uint8Array(STRUCT_BYTES + extension.length)

  let offset = 0
  const put = (value: number, length: number): void => {
    writeBits(bytes, offset, length, value)
    offset += length
  }

  put(version, WIDTH.version)
  put(vendorId, WIDTH.vendorId)
  put(productId, WIDTH.productId)
  put(flow, WIDTH.customFlow)
  put(discovery, WIDTH.discovery)
  put(discriminator, WIDTH.discriminator)
  put(passcode, WIDTH.passcode)
  // The padding bits are reserved and must be zero, which they already are: the array is
  // zero-initialised and decodePayload refuses any payload that sets them.

  bytes.set(extension, STRUCT_BYTES)

  return PAYLOAD_PREFIX + encodeBase38(bytes)
}
