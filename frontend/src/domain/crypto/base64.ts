/**
 * Standard base64 (RFC 4648 §4) for the crypto modules.
 *
 * Hand-rolled rather than `atob`/`btoa`, which are DOM globals this layer does not have
 * (`tsconfig.domain.json` strips the DOM lib so `src/domain` stays runnable anywhere). The
 * decoder began life inside `kid.ts` and moved here when the envelope (#299) needed the same
 * alphabet in both directions.
 *
 * Strict about input: key material or ciphertext recovered from a *mis-decoded* string would be
 * stable, plausible-looking bytes for a value nobody ever produced — a kid naming a key nobody
 * holds, a ciphertext that can never authenticate — so a character outside the alphabet throws
 * instead of being skipped.
 *
 * @module
 */

const BASE64_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'

/**
 * Standard base64 → bytes.
 *
 * @throws {Error} on any character outside the base64 alphabet — see the module note for why
 *   lenient decoding would be worse than failure
 */
export function decodeBase64(value: string): Uint8Array {
  const unpadded = value.replace(/=+$/, '')
  const bytes = new Uint8Array(Math.floor((unpadded.length * 6) / 8))

  let buffer = 0
  let bits = 0
  let at = 0
  for (const character of unpadded) {
    const sextet = BASE64_ALPHABET.indexOf(character)
    if (sextet === -1) throw new Error('Not base64, so the value cannot be decoded.')
    buffer = (buffer << 6) | sextet
    bits += 6
    if (bits >= 8) {
      bits -= 8
      bytes[at] = (buffer >> bits) & 0xff
      at += 1
    }
  }
  return bytes
}

/** Bytes → standard base64, padded — the exact inverse of {@link decodeBase64}. */
export function encodeBase64(bytes: Uint8Array): string {
  let encoded = ''
  let buffer = 0
  let bits = 0
  for (const byte of bytes) {
    buffer = (buffer << 8) | byte
    bits += 8
    while (bits >= 6) {
      bits -= 6
      encoded += BASE64_ALPHABET.charAt((buffer >> bits) & 0x3f)
    }
  }
  if (bits > 0) encoded += BASE64_ALPHABET.charAt((buffer << (6 - bits)) & 0x3f)
  while (encoded.length % 4 !== 0) encoded += '='
  return encoded
}
