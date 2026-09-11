/**
 * Reading the text back out of a generated PDF.
 *
 * M3-4 asks for exactly this: *"text extracted from the PDF matches the original strings"*. It
 * is the only assertion in the whole PDF feature that can prove a character actually survived
 * — a `drawText` call that was handed `Küche` proves nothing about what reached the page, and
 * the classic non-ASCII failure is a glyph that becomes a box or a blank without anything
 * throwing.
 *
 * Hand-rolled rather than borrowed. A PDF text extractor in general is a large problem; this
 * one only has to read documents *this repository writes*, which use one font encoding, no
 * text matrices beyond the ones written here, and no ligature substitution. Adding a PDF
 * parsing library as a devDependency of a package that ships a bundle is a dependency-policy
 * conversation (ADR 0013) for a forty-line job.
 *
 * Test support, not shipped: this file is under `test/`.
 *
 * @module
 */

/** Inflates a zlib stream using the platform, so no compression library is needed. */
async function inflate(bytes: Uint8Array): Promise<Uint8Array> {
  const stream = new Blob([bytes as BlobPart])
    .stream()
    .pipeThrough(new DecompressionStream('deflate'))
  return new Uint8Array(await new Response(stream).arrayBuffer())
}

/** Every `stream … endstream` payload in the file, in order. */
function streams(pdf: Uint8Array): Uint8Array[] {
  const found: Uint8Array[] = []
  const marker = new TextEncoder().encode('stream')
  const end = new TextEncoder().encode('endstream')

  const at = (needle: Uint8Array, from: number): number => {
    outer: for (let index = from; index <= pdf.length - needle.length; index += 1) {
      for (let offset = 0; offset < needle.length; offset += 1) {
        if (pdf[index + offset] !== needle[offset]) continue outer
      }
      return index
    }
    return -1
  }

  let cursor = 0
  while (cursor < pdf.length) {
    const start = at(marker, cursor)
    if (start === -1) break
    // `stream` is followed by CRLF or LF, per the specification.
    let body = start + marker.length
    if (pdf[body] === 0x0d) body += 1
    if (pdf[body] === 0x0a) body += 1

    let stop = at(end, body)
    if (stop === -1) break
    const after = stop + end.length

    // The specification puts an end-of-line before `endstream`, and it is not part of the
    // stream data. `DecompressionStream` rejects trailing bytes outright rather than ignoring
    // them, so leaving them on turns every stream in the file into "not compressed" — which
    // is how this extractor first came to find no text at all while looking like it worked.
    while (stop > body && (pdf[stop - 1] === 0x0a || pdf[stop - 1] === 0x0d)) stop -= 1

    found.push(pdf.subarray(body, stop))
    cursor = after
  }
  return found
}

/**
 * WinAnsi byte to character, for the range that differs from Latin-1.
 *
 * The standard-14 fonts are WinAnsi-encoded, and WinAnsi is Latin-1 *except* in 0x80–0x9F,
 * where Latin-1 has control characters and WinAnsi has typography. Everything German needs —
 * ä ö ü Ä Ö Ü ß — is in the Latin-1 range and needs no special case; the table is here so that
 * an ellipsis or a quotation mark in a device name is read back as itself rather than as a
 * control character, which would look like corruption in a failing test.
 */
const WIN_ANSI_HIGH: Readonly<Record<number, string>> = {
  128: '€',
  130: '‚',
  131: 'ƒ',
  132: '„',
  133: '…',
  134: '†',
  135: '‡',
  136: 'ˆ',
  137: '‰',
  138: 'Š',
  139: '‹',
  140: 'Œ',
  142: 'Ž',
  145: '‘',
  146: '’',
  147: '“',
  148: '”',
  149: '•',
  150: '–',
  151: '—',
  152: '˜',
  153: '™',
  154: 'š',
  155: '›',
  156: 'œ',
  158: 'ž',
  159: 'Ÿ',
}

const fromWinAnsi = (code: number): string => WIN_ANSI_HIGH[code] ?? String.fromCharCode(code)

/**
 * Every string drawn in the document.
 *
 * `pdf-lib` writes standard-font text as a hex string — `<4bfc6368 65> Tj` — so that is the
 * form parsed. Literal `(…)` strings are handled too, since a hand-written stream or a future
 * `pdf-lib` could produce them, and a parser that silently found nothing would make this whole
 * test vacuous.
 */
export async function extractText(pdf: Uint8Array): Promise<string[]> {
  const decoder = new TextDecoder('latin1')
  const drawn: string[] = []

  for (const stream of streams(pdf)) {
    let content: string
    try {
      content = decoder.decode(await inflate(stream))
    } catch {
      // Not a compressed stream — an embedded image, or an uncompressed one.
      content = decoder.decode(stream)
    }

    for (const match of content.matchAll(/<([0-9a-fA-F\s]+)>\s*Tj/g)) {
      const hex = (match[1] ?? '').replace(/\s+/g, '')
      let text = ''
      for (let index = 0; index + 1 < hex.length; index += 2) {
        text += fromWinAnsi(Number.parseInt(hex.slice(index, index + 2), 16))
      }
      drawn.push(text)
    }

    for (const match of content.matchAll(/\(((?:\\.|[^()\\])*)\)\s*Tj/g)) {
      drawn.push((match[1] ?? '').replace(/\\([()\\])/g, '$1'))
    }
  }

  return drawn
}
