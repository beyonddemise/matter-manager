import { deflateRawSync, inflateRawSync } from 'node:zlib'
import { describe, expect, it } from 'vitest'
import { ZipError } from '../../../src/domain/archive/zip.js'
import { streamCodecs } from '../../../src/ui/archive/codec.js'

/**
 * The browser's `CompressionStream` / `DecompressionStream` as the zip module's codecs.
 *
 * Checked against Node's zlib in both directions, so each side is read by an implementation
 * that is not itself.
 */

const text = (value: string): Uint8Array => new TextEncoder().encode(value)

describe('the stream codecs', () => {
  it('deflate to raw deflate that zlib inflates', async () => {
    const data = text('hello world '.repeat(200))

    const deflated = await streamCodecs.deflate(data)

    expect(deflated.length).toBeLessThan(data.length)
    expect(new Uint8Array(inflateRawSync(deflated))).toEqual(data)
  })

  it('inflate what zlib deflated', async () => {
    const data = text('Küche '.repeat(100))

    expect(await streamCodecs.inflate(new Uint8Array(deflateRawSync(data)), 10_000)).toEqual(data)
  })

  it('stop inflating at the limit, with tooLarge', async () => {
    // 1 MB of zeros deflates to about a kilobyte: a zip bomb in miniature.
    const bomb = new Uint8Array(deflateRawSync(new Uint8Array(1_000_000)))

    const failure = await streamCodecs.inflate(bomb, 10_000).catch((error: unknown) => error)

    expect(failure).toBeInstanceOf(ZipError)
    expect((failure as ZipError).problem).toBe('tooLarge')
  })

  it('report data that is not deflate as corrupt', async () => {
    const failure = await streamCodecs
      .inflate(text('this is not deflate data at all'), 10_000)
      .catch((error: unknown) => error)

    expect(failure).toBeInstanceOf(ZipError)
    expect((failure as ZipError).problem).toBe('corrupt')
  })
})
