/**
 * Base38 codec for Matter onboarding payloads.
 *
 * A Matter QR code carries the text `MT:` followed by a Base38-encoded binary blob.
 * Base38 exists rather than Base64 because QR codes have an *alphanumeric* encoding mode
 * covering only digits, uppercase letters and a handful of symbols. Staying inside that
 * character set keeps the code physically smaller and easier for a phone to read from a
 * curled label in poor light, which is exactly the situation this application exists for.
 *
 * The scheme is chunked rather than a single big-integer conversion: bytes are taken 3 at
 * a time and emitted as 5 characters, so encoding is streamable and a corrupted chunk
 * cannot cascade through the rest of the payload.
 *
 * @module
 */

/**
 * The Base38 alphabet, in value order: digits, uppercase letters, then `-` and `.`.
 *
 * Deliberately excludes lowercase letters and the QR alphanumeric symbols that would be
 * ambiguous when read off a printed label.
 */
export const BASE38_ALPHABET = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ-.'

const RADIX = 38

/**
 * How many characters encode how many bytes.
 *
 * Fixed by the specification. A full chunk is 3 bytes / 5 characters; a payload whose
 * length is not a multiple of 3 ends in a short chunk of 2 bytes / 4 characters or
 * 1 byte / 2 characters. No other combination is legal, which is what makes a trailing
 * chunk of 1, 3 or 6 characters detectably corrupt.
 */
const CHARS_PER_BYTE_COUNT: Readonly<Record<number, number>> = { 1: 2, 2: 4, 3: 5 }
const BYTE_COUNT_PER_CHARS: Readonly<Record<number, number>> = { 2: 1, 4: 2, 5: 3 }

/** Highest value each chunk size may legally carry, i.e. 2^(8*bytes) - 1. */
const MAX_VALUE_PER_BYTE_COUNT: Readonly<Record<number, number>> = {
  1: 0xff,
  2: 0xffff,
  3: 0xffffff,
}

/** Thrown when a string is not valid Base38 as Matter defines it. */
export class Base38Error extends Error {
  override readonly name = 'Base38Error'
}

/**
 * Decodes a Base38 string into the bytes it represents.
 *
 * Chunking is fixed by the specification: 5 characters decode to 3 bytes, and a trailing
 * partial chunk of 4 characters decodes to 2 bytes or 2 characters to 1 byte. Any other
 * trailing length is invalid.
 *
 * @param encoded Base38 text, without the `MT:` prefix.
 * @returns The decoded bytes.
 * @throws {Base38Error} If the input contains a character outside {@link BASE38_ALPHABET},
 *   ends with a chunk length that cannot represent a whole number of bytes, or contains a
 *   chunk whose value does not fit the bytes it is supposed to occupy.
 */
export function decodeBase38(encoded: string): Uint8Array {
  const bytes: number[] = []

  for (let cursor = 0; cursor < encoded.length; ) {
    const remaining = encoded.length - cursor
    const chunkLength = remaining >= 5 ? 5 : remaining
    const byteCount = BYTE_COUNT_PER_CHARS[chunkLength]

    if (byteCount === undefined) {
      throw new Base38Error(
        `Invalid Base38 length: a trailing chunk of ${chunkLength} character(s) cannot represent a whole number of bytes.`,
      )
    }

    // Least significant digit first, so accumulate from the end of the chunk backwards.
    let value = 0
    for (let digit = chunkLength - 1; digit >= 0; digit--) {
      const char = encoded[cursor + digit] as string
      const digitValue = BASE38_ALPHABET.indexOf(char)
      if (digitValue < 0) {
        throw new Base38Error(
          `Invalid Base38 character ${JSON.stringify(char)} at position ${cursor + digit}.`,
        )
      }
      value = value * RADIX + digitValue
    }

    // A chunk can express more than its bytes can hold. Truncating silently would turn a
    // damaged code into a different, plausible-looking device rather than an error.
    const maxValue = MAX_VALUE_PER_BYTE_COUNT[byteCount] as number
    if (value > maxValue) {
      throw new Base38Error(
        // The decoded value is not reported: for a Matter payload it is up to three bytes of
        // the packed struct, which can span the passcode. Position and limit locate the fault
        // without carrying any of the data.
        `Base38 chunk at position ${cursor} decodes to a value above the maximum ${maxValue} for ${byteCount} byte(s).`,
      )
    }

    for (let byte = 0; byte < byteCount; byte++) {
      bytes.push((value >>> (8 * byte)) & 0xff)
    }

    cursor += chunkLength
  }

  return Uint8Array.from(bytes)
}

/**
 * Encodes bytes as Base38.
 *
 * The inverse of {@link decodeBase38}. Round-tripping any byte sequence through
 * {@link encodeBase38} and back is lossless.
 *
 * @param bytes The bytes to encode.
 * @returns Base38 text, without the `MT:` prefix.
 */
export function encodeBase38(bytes: Uint8Array): string {
  let encoded = ''

  for (let cursor = 0; cursor < bytes.length; cursor += 3) {
    const byteCount = Math.min(3, bytes.length - cursor)

    let value = 0
    for (let byte = 0; byte < byteCount; byte++) {
      value += (bytes[cursor + byte] as number) * 2 ** (8 * byte)
    }

    // Emitting only significant digits would drop leading zeros, so a payload beginning
    // with zero bytes would decode shorter than it was encoded. The chunk width is fixed
    // by the byte count, not by the value.
    const chunkLength = CHARS_PER_BYTE_COUNT[byteCount] as number
    for (let digit = 0; digit < chunkLength; digit++) {
      encoded += BASE38_ALPHABET[value % RADIX]
      value = Math.floor(value / RADIX)
    }
  }

  return encoded
}
