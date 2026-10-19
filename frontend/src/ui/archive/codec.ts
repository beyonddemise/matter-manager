/**
 * Raw deflate for the zip module, from the browser's own `CompressionStream`.
 *
 * `deflate-raw` is the form zip stores (RFC 1951 with no zlib or gzip wrapper), and every
 * browser the application supports has it, so the export needs no compression library
 * (ADR 0013). `domain/archive/zip.ts` takes these as {@link ZipCodecs} because that package
 * reaches for nothing ambient.
 *
 * @module
 */

import { type ZipCodecs, ZipError } from '../../domain/archive/zip.js'

/** Everything a stream yields, joined into one array. */
async function collect(
  stream: ReadableStream<Uint8Array>,
  limit = Number.POSITIVE_INFINITY,
): Promise<Uint8Array> {
  const chunks: Uint8Array[] = []
  let length = 0
  const reader = stream.getReader()
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    length += value.length
    // Checked per chunk, so a zip bomb is stopped after a little more than `limit` bytes
    // rather than after it has filled the device's memory.
    if (length > limit) {
      await reader.cancel()
      throw new ZipError('tooLarge', `An entry inflates to over ${limit} bytes.`)
    }
    chunks.push(value)
  }
  const out = new Uint8Array(length)
  let at = 0
  for (const chunk of chunks) {
    out.set(chunk, at)
    at += chunk.length
  }
  return out
}

/** Runs bytes through a transform stream. */
function through(
  data: Uint8Array,
  transform: CompressionStream | DecompressionStream,
  limit?: number,
): Promise<Uint8Array> {
  const source = new Blob([data as BlobPart]).stream()
  return collect(source.pipeThrough(transform) as ReadableStream<Uint8Array>, limit)
}

/** The zip module's codecs, on `CompressionStream` and `DecompressionStream`. */
export const streamCodecs: ZipCodecs = {
  deflate: (data) => through(data, new CompressionStream('deflate-raw')),

  async inflate(data, limit) {
    try {
      return await through(data, new DecompressionStream('deflate-raw'), limit)
    } catch (cause) {
      if (cause instanceof ZipError) throw cause
      // The stream's own errors (a TypeError in browsers) mean the bytes are not deflate.
      throw new ZipError('corrupt', 'An entry in the zip is damaged.', { cause })
    }
  },
}
