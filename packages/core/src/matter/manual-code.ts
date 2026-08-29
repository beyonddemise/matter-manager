/**
 * Matter manual pairing code: the numeric fallback printed beside the QR code.
 *
 * It exists for the case this application is largely about — a code that cannot be scanned,
 * because the label is small, curled, poorly lit, or mounted somewhere a camera cannot reach.
 * The digits can always be read and typed.
 *
 * Two forms, distinguished by a flag in the first digit:
 *
 * | Digits | Contents                                                        |
 * |--------|-----------------------------------------------------------------|
 * | 1      | vendor/product-present flag (bit 2), top 2 bits of the short discriminator |
 * | 2-6    | low 2 bits of the short discriminator, then the low 14 bits of the passcode |
 * | 7-10   | the remaining 13 bits of the passcode                           |
 * | 11-15  | vendor id, long form only                                       |
 * | 16-20  | product id, long form only                                      |
 * | last   | Verhoeff check digit                                            |
 *
 * **The code carries only the top four bits of the twelve-bit discriminator.** That loss is
 * inherent to the format, not a shortcut taken here, and it is why parsing reports a
 * `shortDiscriminator` rather than a `discriminator`: 256 different discriminators produce
 * the same manual code, and a caller who treated the parsed value as a full one would be
 * wrong by a factor of 256 in a way that looks entirely reasonable.
 *
 * @module
 */

import { PayloadError, requireInRange } from './payload.js'
import { isVerhoeffValid, verhoeffCheckDigit } from './verhoeff.js'

/** Fields needed to derive a manual pairing code. */
export interface ManualCodeInput {
  /** The full twelve-bit discriminator; only its top four bits reach the code. */
  readonly discriminator: number
  /** **Secret.** Never log this. */
  readonly passcode: number
  /** Supply with {@link productId} to derive the 21-digit form, or omit both. */
  readonly vendorId?: number
  readonly productId?: number
}

/** What a manual pairing code actually contains. */
export interface ManualCode {
  /** The top four bits of the discriminator — all the code carries. */
  readonly shortDiscriminator: number
  /** **Secret.** Never log this. */
  readonly passcode: number
  /** Present only in the 21-digit form. */
  readonly vendorId?: number
  readonly productId?: number
}

const SHORT_LENGTH = 11
const LONG_LENGTH = 21

/** Bit 2 of the first digit says whether vendor and product ids follow. */
const VENDOR_PRODUCT_PRESENT = 0b100

/**
 * Bit 3 of the first digit is outside this format.
 *
 * The digit holds the vendor/product flag in bit 2 and the discriminator's top two bits in
 * bits 0-1, so its defined range is 0 to 7. A leading 8 or 9 belongs to a later format, and
 * the reference parser refuses both for that reason.
 */
const RESERVED_FORMAT = 0b1000

/** Separators people copy from a printed label, which carry no meaning. */
const SEPARATORS = /[\s-]/g

const WIDTH = { discriminator: 12, passcode: 27, vendorProduct: 16 } as const

/** How many of the discriminator's bits survive into a manual code. */
const SHORT_DISCRIMINATOR_SHIFT = 8

const padded = (value: number, width: number): string => String(value).padStart(width, '0')

/**
 * Derives the manual pairing code for a device.
 *
 * Supplying `vendorId` and `productId` produces the 21-digit form; omitting both produces the
 * 11-digit form. They must be given together — a code carrying one without the other is not
 * a shape the format has.
 *
 * @param input The device's discriminator and passcode, optionally with vendor and product.
 * @returns The complete code including its check digit, digits only.
 * @throws {PayloadError} If any field is outside its permitted range, or exactly one of
 *   `vendorId` and `productId` is supplied.
 */
export function deriveManualCode(input: ManualCodeInput): string {
  const discriminator = requireInRange('discriminator', input.discriminator, WIDTH.discriminator)
  const passcode = requireInRange('passcode', input.passcode, WIDTH.passcode)

  const hasVendor = input.vendorId !== undefined
  const hasProduct = input.productId !== undefined
  if (hasVendor !== hasProduct) {
    throw new PayloadError(
      'vendorProductNotPaired',
      'vendorId and productId must be supplied together, or both omitted; the manual pairing code has no form carrying one without the other.',
    )
  }

  const short = discriminator >> SHORT_DISCRIMINATOR_SHIFT
  const flag = hasVendor ? VENDOR_PRODUCT_PRESENT : 0

  let body =
    String(flag | (short >> 2)) +
    padded(((short & 0b11) << 14) | (passcode & 0x3fff), 5) +
    padded(passcode >>> 14, 4)

  if (hasVendor) {
    body +=
      padded(requireInRange('vendorId', input.vendorId as number, WIDTH.vendorProduct), 5) +
      padded(requireInRange('productId', input.productId as number, WIDTH.vendorProduct), 5)
  }

  return body + verhoeffCheckDigit(body)
}

/**
 * Parses a manual pairing code back into the fields it carries.
 *
 * Whitespace and hyphens are ignored, because people copy codes as they are grouped on the
 * label. Everything else must be a digit.
 *
 * @param code The code as typed, with or without separators.
 * @returns The fields the code contains. Note {@link ManualCode.shortDiscriminator}: the full
 *   discriminator is not recoverable from a manual code and is deliberately not invented.
 * @throws {PayloadError} If the length is not 11 or 21 digits, a character is not a digit, the
 *   check digit does not match, the vendor/product flag disagrees with the length, or a field
 *   decodes to a value outside its permitted range.
 */
export function parseManualCode(code: string): ManualCode {
  const digits = code.replace(SEPARATORS, '')

  if (digits.length !== SHORT_LENGTH && digits.length !== LONG_LENGTH) {
    throw new PayloadError(
      'manualCodeLength',
      `A manual pairing code has ${SHORT_LENGTH} or ${LONG_LENGTH} digits; received ${digits.length}.`,
    )
  }

  if (!/^\d+$/.test(digits)) {
    throw new PayloadError(
      'manualCodeNotDigits',
      // The code is not echoed; it carries the passcode.
      `A manual pairing code contains only digits, separators aside; this one has other characters.`,
    )
  }

  // Before reading any field: a code that fails its check digit was mistyped, and every
  // value read out of it would be wrong in a way that still looks like a device.
  if (!isVerhoeffValid(digits)) {
    throw new PayloadError(
      'manualCodeCheckDigit',
      'The check digit does not match; the manual pairing code was mistyped or misread.',
    )
  }

  const first = Number(digits[0])

  // Checked before any field is read, and before the vendor/product flag, because a later
  // format may lay its fields out differently - complaining that the flag disagrees with the
  // length would send the reader to the wrong part of the specification. Ignoring this bit
  // instead would silently reinterpret the code: a leading 8 parses exactly as a leading 0,
  // describing a plausible device that is not the one on the label.
  if ((first & RESERVED_FORMAT) !== 0) {
    throw new PayloadError(
      'manualCodeUnknownFormat',
      `A manual pairing code beginning with ${first} uses a format this version does not define; only leading digits 0 to 7 are valid here.`,
    )
  }

  const vendorProductPresent = (first & VENDOR_PRODUCT_PRESENT) !== 0
  const expectedLength = vendorProductPresent ? LONG_LENGTH : SHORT_LENGTH
  if (digits.length !== expectedLength) {
    throw new PayloadError(
      'manualCodeLengthContradictsFlag',
      `The leading digit says vendor and product ids ${
        vendorProductPresent ? 'follow' : 'do not follow'
      }, but the code has ${digits.length} digits rather than ${expectedLength}. Trusting the length instead would read the wrong fields.`,
    )
  }

  const group = Number(digits.slice(1, 6))
  if (group > 0xffff) {
    throw new PayloadError(
      'manualCodeGroupOutOfRange',
      // The decoded group is not reported; its low 14 bits are the passcode's.
      `Digits 2-6 decode to a value above the 16 bits they occupy; the code is malformed.`,
    )
  }

  const shortDiscriminator = ((first & 0b11) << 2) | (group >> 14)
  const passcode = (group & 0x3fff) | (Number(digits.slice(6, 10)) << 14)
  requireInRange('passcode', passcode, WIDTH.passcode)

  if (!vendorProductPresent) return { shortDiscriminator, passcode }

  return {
    shortDiscriminator,
    passcode,
    vendorId: requireInRange('vendorId', Number(digits.slice(10, 15)), WIDTH.vendorProduct),
    productId: requireInRange('productId', Number(digits.slice(15, 20)), WIDTH.vendorProduct),
  }
}
