/**
 * Reading a setup code down to its vendor and product IDs, and no further.
 *
 * The browser sends the whole code to `POST /catalog/lookup` (ADR 0019), and this is the only
 * thing the service does with it: find the two IDs the DCL is asked about. The discriminator and
 * the passcode are never extracted, so they cannot end up in a variable somebody later logs.
 *
 * **The backend's own decoder**, not an import from the frontend: ADR 0017 keeps the two halves
 * free of shared code. What keeps them agreeing is that both are tested against the same
 * reference vectors — `frontend/test/domain/matter/payload.test.ts` and `manual-code.test.ts`.
 *
 * **No error message contains the code**, or any part of it. An error message is the most
 * reliable way for a value to reach a log or a response body, and this value is a credential.
 *
 * @module
 */

/** Why a code could not be read: not a code at all, or a valid one that names no product. */
export type CodeErrorKind = 'malformed' | 'no-ids'

/** A code that cannot be read down to a vendor and product ID. Never carries the code itself. */
export class CodeError extends Error {
  override readonly name = 'CodeError'
  readonly kind: CodeErrorKind

  constructor(kind: CodeErrorKind, message: string) {
    super(message)
    this.kind = kind
  }
}

/** The two IDs the DCL is keyed by. */
export interface CodeIds {
  readonly vendorId: number
  readonly productId: number
}

/** The QR payload prefix. Exact and upper-case: Base-38 has no lower-case letters. */
const PREFIX = 'MT:'

/** Base-38 in value order: digits, upper-case letters, then `-` and `.`. */
const ALPHABET = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ-.'

/** Characters per Base-38 chunk → bytes it carries. Any other trailing length is corrupt. */
const BYTES_PER_CHUNK: Readonly<Record<number, number>> = { 2: 1, 4: 2, 5: 3 }

/** The fixed part of a QR payload: 88 bits, of which the last 4 are reserved padding. */
const STRUCT_BYTES = 11

/** Bit offsets in the packed payload: version (3 bits) comes first. */
const VENDOR_OFFSET = 3
const PRODUCT_OFFSET = 19
const PADDING_OFFSET = 84

/**
 * Longer than any setup code, by a wide margin: the spec caps a payload at 255 characters.
 *
 * Checked before anything else so a 64 KiB body costs one comparison rather than a decode.
 */
const MAX_CODE_LENGTH = 512

const SHORT_MANUAL = 11
const LONG_MANUAL = 21

/** Spaces and hyphens a person types or a label prints between digit groups. */
const SEPARATORS = /[\s-]/g

/** Verhoeff tables, as in the Matter specification §5.1.4.1. */
const MULTIPLY: readonly (readonly number[])[] = [
  [0, 1, 2, 3, 4, 5, 6, 7, 8, 9],
  [1, 2, 3, 4, 0, 6, 7, 8, 9, 5],
  [2, 3, 4, 0, 1, 7, 8, 9, 5, 6],
  [3, 4, 0, 1, 2, 8, 9, 5, 6, 7],
  [4, 0, 1, 2, 3, 9, 5, 6, 7, 8],
  [5, 9, 8, 7, 6, 0, 4, 3, 2, 1],
  [6, 5, 9, 8, 7, 1, 0, 4, 3, 2],
  [7, 6, 5, 9, 8, 2, 1, 0, 4, 3],
  [8, 7, 6, 5, 9, 3, 2, 1, 0, 4],
  [9, 8, 7, 6, 5, 4, 3, 2, 1, 0],
]
const PERMUTE: readonly (readonly number[])[] = [
  [0, 1, 2, 3, 4, 5, 6, 7, 8, 9],
  [1, 5, 7, 6, 2, 8, 3, 0, 9, 4],
  [5, 8, 0, 3, 7, 9, 6, 1, 4, 2],
  [8, 9, 1, 6, 0, 4, 3, 5, 2, 7],
  [9, 4, 5, 3, 1, 2, 6, 8, 7, 0],
  [4, 2, 8, 6, 5, 7, 3, 9, 0, 1],
  [2, 7, 9, 3, 8, 0, 6, 4, 1, 5],
  [7, 0, 4, 6, 9, 1, 3, 2, 5, 8],
]

const malformed = (message: string): CodeError => new CodeError('malformed', message)

/**
 * The vendor and product IDs in a setup code.
 *
 * Accepts what the browser stores: a QR payload (`MT:` and Base-38) or a manual pairing code,
 * with surrounding whitespace and the usual digit-group separators tolerated.
 *
 * @throws {CodeError} `malformed` for anything that is not a valid code, `no-ids` for a valid
 *   11-digit manual code, which carries no vendor or product ID.
 */
export function decodeCode(code: string): CodeIds {
  if (code.length > MAX_CODE_LENGTH) throw malformed('Longer than any setup code.')

  const trimmed = code.trim()
  // Case-insensitive *detection* only. A lower-case prefix is a payload somebody typed, and it
  // is refused below as one, rather than mistaken for a manual code with letters in it.
  if (/^mt:/i.test(trimmed)) return decodeQr(trimmed)

  const digits = trimmed.replace(SEPARATORS, '')
  if (/^\d+$/.test(digits)) return decodeManual(digits)

  throw malformed('Neither a Matter QR payload nor a manual pairing code.')
}

/** The IDs in a QR payload. See the Matter Core Specification §5.1.3. */
function decodeQr(text: string): CodeIds {
  // The frontend's `decodePayload` refuses a lower-case prefix too; agreeing with it means a
  // code the browser could not have stored is not one this service accepts either.
  if (!text.startsWith(PREFIX)) throw malformed('The QR payload prefix must be upper-case.')

  const bytes = base38(text.slice(PREFIX.length))
  if (bytes.length < STRUCT_BYTES) throw malformed('The QR payload is too short.')
  // Cheap, and the one structural check the fixed part offers: a payload whose padding is set
  // was not produced by a Matter encoder, so its "IDs" are noise.
  if (readBits(bytes, PADDING_OFFSET, 4) !== 0) throw malformed('The reserved bits are set.')

  return {
    vendorId: readBits(bytes, VENDOR_OFFSET, 16),
    productId: readBits(bytes, PRODUCT_OFFSET, 16),
  }
}

/** Base-38, as Matter chunks it: 5 characters for 3 bytes, 4 for 2, 2 for 1. */
function base38(body: string): Uint8Array {
  if (body === '') throw malformed('Nothing follows the QR payload prefix.')

  const bytes: number[] = []
  for (let cursor = 0; cursor < body.length; ) {
    const length = Math.min(5, body.length - cursor)
    const count = BYTES_PER_CHUNK[length]
    if (count === undefined) throw malformed('The QR payload length is not valid Base-38.')

    let value = 0
    // Little-endian within a chunk: the first character is the least significant digit.
    for (let digit = length - 1; digit >= 0; digit -= 1) {
      const index = ALPHABET.indexOf(body.charAt(cursor + digit))
      if (index < 0) throw malformed('The QR payload contains a character outside Base-38.')
      value = value * ALPHABET.length + index
    }
    if (value >= 2 ** (8 * count)) throw malformed('A Base-38 chunk is out of range.')

    for (let byte = 0; byte < count; byte += 1) bytes.push((value >>> (8 * byte)) & 0xff)
    cursor += length
  }
  return Uint8Array.from(bytes)
}

/** `length` bits from `offset`, least significant first, as the payload packs them. */
function readBits(bytes: Uint8Array, offset: number, length: number): number {
  let value = 0
  for (let index = 0; index < length; index += 1) {
    const bit = offset + index
    if ((((bytes[bit >> 3] ?? 0) >> (bit & 7)) & 1) === 1) value |= 1 << index
  }
  return value
}

/** The IDs in a manual pairing code. See the Matter Core Specification §5.1.4. */
function decodeManual(digits: string): CodeIds {
  if (digits.length !== SHORT_MANUAL && digits.length !== LONG_MANUAL) {
    throw malformed('A manual pairing code has 11 or 21 digits.')
  }
  // Before reading anything: a mistyped digit in the ID groups would otherwise ask the DCL
  // about somebody else's product, and answer with its name as if it were this one.
  if (!verhoeffValid(digits)) throw malformed('The check digit does not match.')

  const first = Number(digits.charAt(0))
  if ((first & 0b1000) !== 0) throw malformed('A leading 8 or 9 is a format this does not know.')

  const hasIds = (first & 0b100) !== 0
  if (hasIds !== (digits.length === LONG_MANUAL)) {
    throw malformed('The leading digit contradicts the length.')
  }
  if (!hasIds) throw new CodeError('no-ids', 'This code carries no vendor or product ID.')

  const vendorId = Number(digits.slice(10, 15))
  const productId = Number(digits.slice(15, 20))
  if (vendorId > 0xffff || productId > 0xffff) throw malformed('An ID is out of range.')
  return { vendorId, productId }
}

/** Whether the last digit is the Verhoeff check digit of the rest. */
function verhoeffValid(digits: string): boolean {
  let check = 0
  for (let index = 0; index < digits.length; index += 1) {
    const digit = digits.charCodeAt(digits.length - 1 - index) - 48
    const permuted = PERMUTE[index % 8]?.[digit] ?? 0
    check = MULTIPLY[check]?.[permuted] ?? 0
  }
  return check === 0
}
