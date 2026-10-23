/**
 * UTF-8, both ways, without `TextEncoder` or `TextDecoder`.
 *
 * `domain` reaches for nothing ambient and is type-checked without the DOM library, so the
 * archive code that turns JSON and file names into bytes cannot use the platform's codecs.
 * This is the small, strict version of them: encoding writes a lone surrogate as U+FFFD as
 * `TextEncoder` does, and decoding **refuses** anything malformed (overlong forms, encoded
 * surrogates, code points past U+10FFFF, truncation) the way `TextDecoder` does with
 * `fatal: true`. An imported file is not trusted, and silently replacing a bad byte with U+FFFD
 * would turn a damaged archive into a different, valid-looking one.
 *
 * @module
 */

/** Thrown for bytes that are not well-formed UTF-8. */
export class Utf8Error extends Error {
  override readonly name = 'Utf8Error'
}

/** Encodes text as UTF-8. Lone surrogates become U+FFFD. */
export function encodeUtf8(text: string): Uint8Array {
  const out: number[] = []
  for (let index = 0; index < text.length; index++) {
    let code = text.charCodeAt(index)
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = text.charCodeAt(index + 1)
      if (next >= 0xdc00 && next <= 0xdfff) {
        code = 0x10000 + ((code - 0xd800) << 10) + (next - 0xdc00)
        index++
      } else {
        code = 0xfffd
      }
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      code = 0xfffd
    }

    if (code < 0x80) out.push(code)
    else if (code < 0x800) out.push(0xc0 | (code >> 6), 0x80 | (code & 0x3f))
    else if (code < 0x10000) {
      out.push(0xe0 | (code >> 12), 0x80 | ((code >> 6) & 0x3f), 0x80 | (code & 0x3f))
    } else {
      out.push(
        0xf0 | (code >> 18),
        0x80 | ((code >> 12) & 0x3f),
        0x80 | ((code >> 6) & 0x3f),
        0x80 | (code & 0x3f),
      )
    }
  }
  return Uint8Array.from(out)
}

/**
 * Decodes UTF-8, refusing anything malformed.
 *
 * A leading byte-order mark is kept as U+FEFF rather than stripped: the archive never writes
 * one, and keeping it makes a file that has one fail the JSON parse visibly instead of passing
 * for a different file.
 *
 * @throws {Utf8Error} For a sequence that is truncated, overlong, a surrogate, or past U+10FFFF.
 */
export function decodeUtf8(bytes: Uint8Array): string {
  let out = ''
  let index = 0
  const continuation = (at: number): number => {
    const byte = bytes[at]
    if (byte === undefined || (byte & 0xc0) !== 0x80) {
      throw new Utf8Error(`Malformed UTF-8 at byte ${at}.`)
    }
    return byte & 0x3f
  }

  while (index < bytes.length) {
    const lead = bytes[index] as number
    let code: number
    let length: number
    let minimum: number
    if (lead < 0x80) {
      code = lead
      length = 1
      minimum = 0
    } else if (lead >= 0xc2 && lead <= 0xdf) {
      code = lead & 0x1f
      length = 2
      minimum = 0x80
    } else if (lead >= 0xe0 && lead <= 0xef) {
      code = lead & 0x0f
      length = 3
      minimum = 0x800
    } else if (lead >= 0xf0 && lead <= 0xf4) {
      code = lead & 0x07
      length = 4
      minimum = 0x10000
    } else {
      throw new Utf8Error(`Malformed UTF-8 at byte ${index}.`)
    }
    for (let k = 1; k < length; k++) code = (code << 6) | continuation(index + k)
    if (code < minimum || code > 0x10ffff || (code >= 0xd800 && code <= 0xdfff)) {
      throw new Utf8Error(`Malformed UTF-8 at byte ${index}.`)
    }
    out += String.fromCodePoint(code)
    index += length
  }
  return out
}
