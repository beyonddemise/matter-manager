import { deflateRawSync, inflateRawSync } from 'node:zlib'
import { describe, expect, it } from 'vitest'
import {
  crc32,
  readZip,
  writeZip,
  type ZipCodecs,
  ZipError,
  type ZipLimits,
} from '../../../src/domain/archive/zip.js'

/**
 * The zip container the project export is written in, and read back from on import.
 *
 * The codecs are Node's zlib here, deliberately not the browser streams the application uses:
 * the container logic is then checked against a second, independent deflate implementation.
 * The reference archives below were made by Info-ZIP `zip(1)` and their CRCs read back with
 * `unzip -lv`, so neither the fixtures nor the expected values come from this code (lesson L1).
 */

const codecs: ZipCodecs = {
  deflate: async (data) => new Uint8Array(deflateRawSync(data)),
  inflate: async (data, limit) => {
    const out = new Uint8Array(inflateRawSync(data))
    if (out.length > limit) throw new ZipError('tooLarge', 'inflated past the limit')
    return out
  },
}

const LIMITS: ZipLimits = { maxBytes: 1_000_000, maxInflatedBytes: 1_000_000, maxEntries: 100 }

const text = (value: string): Uint8Array => new TextEncoder().encode(value)
const decode = (bytes: Uint8Array): string => new TextDecoder().decode(bytes)
const base64 = (value: string): Uint8Array => new Uint8Array(Buffer.from(value, 'base64'))

/** `zip -X -D` of `manifest.json` (47 bytes) and `devices/a.json` ("hello world " × 50). */
const DEFLATED_BY_ZIP =
  'UEsDBBQAAAAIAGh3U10WeFbALgAAAC8AAAANAAAAbWFuaWZlc3QuanNvbqtWSssvyk0sUbJSApIlqUW6uYl5ielAuqAoPys1uURJR6kstag4Mz9PycqwFgBQSwMEFAAAAAgAaHdTXQ0urSUVAAAAWAIAAA4AAABkZXZpY2VzL2EuanNvbstIzcnJVyjPL8pJUcgYZY+yqcQGAFBLAQIeAxQAAAAIAGh3U10WeFbALgAAAC8AAAANAAAAAAAAAAEAAACkgQAAAABtYW5pZmVzdC5qc29uUEsBAh4DFAAAAAgAaHdTXQ0urSUVAAAAWAIAAA4AAAAAAAAAAQAAAKSBWQAAAGRldmljZXMvYS5qc29uUEsFBgAAAAACAAIAdwAAAJoAAAAAAA=='

/** `zip -X -D -0` of `tiny.txt` containing `x`: one stored entry. */
const STORED_BY_ZIP =
  'UEsDBAoAAAAAAGh3U12DFtyMAQAAAAEAAAAIAAAAdGlueS50eHR4UEsBAh4DCgAAAAAAaHdTXYMW3IwBAAAAAQAAAAgAAAAAAAAAAAAAAKSBAAAAAHRpbnkudHh0UEsFBgAAAAABAAEANgAAACcAAAAAAA=='

const MODIFIED = new Date('2026-10-19T14:59:00Z')

describe('crc32', () => {
  it('gives the standard check value for "123456789"', () => {
    // The CRC-32/ISO-HDLC check value every implementation publishes.
    expect(crc32(text('123456789'))).toBe(0xcbf43926)
  })

  it('agrees with the CRCs unzip reports for the reference archive', () => {
    expect(crc32(text('{"format":"matter-manager-project","version":1}'))).toBe(0xc0567816)
    expect(crc32(text('hello world '.repeat(50)))).toBe(0x25ad2e0d)
    expect(crc32(text('x'))).toBe(0x8cdc1683)
  })

  it('is 0 for nothing', () => {
    expect(crc32(new Uint8Array())).toBe(0)
  })
})

describe('reading an archive zip(1) made', () => {
  it('reads deflated entries', async () => {
    const entries = await readZip(base64(DEFLATED_BY_ZIP), codecs, LIMITS)

    expect(entries.map((entry) => entry.name)).toEqual(['manifest.json', 'devices/a.json'])
    expect(decode(entries[0]?.data ?? new Uint8Array())).toBe(
      '{"format":"matter-manager-project","version":1}',
    )
    expect(decode(entries[1]?.data ?? new Uint8Array())).toBe('hello world '.repeat(50))
  })

  it('reads a stored entry', async () => {
    const entries = await readZip(base64(STORED_BY_ZIP), codecs, LIMITS)

    expect(entries).toHaveLength(1)
    expect(entries[0]?.name).toBe('tiny.txt')
    expect(decode(entries[0]?.data ?? new Uint8Array())).toBe('x')
  })
})

describe('writing', () => {
  it('round-trips through its own reader', async () => {
    const written = await writeZip(
      [
        { name: 'manifest.json', data: text('{"a":1}') },
        { name: 'devices/ü.json', data: text('é'.repeat(300)) },
        { name: 'empty.json', data: new Uint8Array() },
      ],
      codecs,
      MODIFIED,
    )

    const read = await readZip(written, codecs, LIMITS)

    expect(read.map((entry) => entry.name)).toEqual([
      'manifest.json',
      'devices/ü.json',
      'empty.json',
    ])
    expect(decode(read[1]?.data ?? new Uint8Array())).toBe('é'.repeat(300))
    expect(read[2]?.data).toHaveLength(0)
  })

  it('writes what an independent inflater reads back', async () => {
    // The first local entry, parsed by hand: an archive only this reader understood would be
    // a backup nobody else could open.
    const written = await writeZip(
      [{ name: 'a.json', data: text('hello world '.repeat(50)) }],
      codecs,
      MODIFIED,
    )
    const view = new DataView(written.buffer, written.byteOffset, written.byteLength)

    expect(view.getUint32(0, true)).toBe(0x04034b50)
    const method = view.getUint16(8, true)
    const crc = view.getUint32(14, true)
    const compressed = view.getUint32(18, true)
    const nameLength = view.getUint16(26, true)
    const extraLength = view.getUint16(28, true)
    const start = 30 + nameLength + extraLength
    const body = written.slice(start, start + compressed)

    expect(method).toBe(8)
    expect(crc).toBe(0x25ad2e0d)
    expect(decode(new Uint8Array(inflateRawSync(body)))).toBe('hello world '.repeat(50))
  })

  it('stores an entry that deflate would not make smaller', async () => {
    const written = await writeZip([{ name: 'x', data: text('x') }], codecs, MODIFIED)
    const view = new DataView(written.buffer, written.byteOffset, written.byteLength)

    expect(view.getUint16(8, true)).toBe(0)
    expect((await readZip(written, codecs, LIMITS))[0]?.data).toEqual(text('x'))
  })

  it('marks names as UTF-8', async () => {
    const written = await writeZip([{ name: 'ü', data: text('x') }], codecs, MODIFIED)
    const view = new DataView(written.buffer, written.byteOffset, written.byteLength)

    // General purpose bit 11: the name is UTF-8, so `unzip` does not read it as CP437.
    expect(view.getUint16(6, true) & 0x0800).toBe(0x0800)
  })

  it('refuses two entries with one name', async () => {
    await expect(
      writeZip(
        [
          { name: 'a', data: text('1') },
          { name: 'a', data: text('2') },
        ],
        codecs,
        MODIFIED,
      ),
    ).rejects.toThrow(RangeError)
  })
})

describe('refusing what it cannot trust', () => {
  const problemOf = async (promise: Promise<unknown>): Promise<string | undefined> => {
    try {
      await promise
      return undefined
    } catch (error) {
      return error instanceof ZipError ? error.problem : `not a ZipError: ${String(error)}`
    }
  }

  it('says a file that is not a zip is not a zip', async () => {
    expect(await problemOf(readZip(text('{"just":"json"}'), codecs, LIMITS))).toBe('notAZip')
    expect(await problemOf(readZip(new Uint8Array(), codecs, LIMITS))).toBe('notAZip')
  })

  it('refuses an entry whose CRC does not match', async () => {
    const bytes = base64(STORED_BY_ZIP)
    // The stored byte `x` is at offset 30 + 8 (the name `tiny.txt`).
    bytes[38] = 0x79

    expect(await problemOf(readZip(bytes, codecs, LIMITS))).toBe('corrupt')
  })

  it('refuses an encrypted entry', async () => {
    const bytes = base64(STORED_BY_ZIP)
    const view = new DataView(bytes.buffer)
    // General purpose bit 0, in the central directory, which is what the reader trusts.
    const central = bytes.indexOf(0x50, 30 + 8 + 1)
    view.setUint16(central + 8, view.getUint16(central + 8, true) | 1, true)

    expect(await problemOf(readZip(bytes, codecs, LIMITS))).toBe('unsupported')
  })

  it('refuses a compression method other than store and deflate', async () => {
    const bytes = base64(STORED_BY_ZIP)
    const view = new DataView(bytes.buffer)
    const central = bytes.indexOf(0x50, 30 + 8 + 1)
    view.setUint16(central + 10, 12, true) // bzip2

    expect(await problemOf(readZip(bytes, codecs, LIMITS))).toBe('unsupported')
  })

  it('refuses a file over the size limit before reading it', async () => {
    const limits = { ...LIMITS, maxBytes: 10 }

    expect(await problemOf(readZip(base64(DEFLATED_BY_ZIP), codecs, limits))).toBe('tooLarge')
  })

  it('refuses more entries than the limit', async () => {
    const limits = { ...LIMITS, maxEntries: 1 }

    expect(await problemOf(readZip(base64(DEFLATED_BY_ZIP), codecs, limits))).toBe('tooLarge')
  })

  it('refuses an archive that would inflate past the limit', async () => {
    // 600 bytes of text in 21 compressed bytes: the shape of a zip bomb, in miniature.
    const limits = { ...LIMITS, maxInflatedBytes: 100 }

    expect(await problemOf(readZip(base64(DEFLATED_BY_ZIP), codecs, limits))).toBe('tooLarge')
  })

  it('refuses an entry that claims more inflated bytes than the limit, without inflating it', async () => {
    let inflated = false
    const watching: ZipCodecs = {
      ...codecs,
      inflate: async (data, limit) => {
        inflated = true
        return codecs.inflate(data, limit)
      },
    }
    const limits = { ...LIMITS, maxInflatedBytes: 100 }

    await expect(readZip(base64(DEFLATED_BY_ZIP), watching, limits)).rejects.toThrow(ZipError)
    expect(inflated).toBe(false)
  })

  it('refuses a name that would climb out of the archive', async () => {
    const written = await writeZip([{ name: 'xx/a', data: text('1') }], codecs, MODIFIED)
    // Rewrite `xx/a` to `../a` in both headers.
    for (let at = written.indexOf(0x78); at !== -1; at = written.indexOf(0x78, at + 2)) {
      if (written[at + 1] === 0x78) {
        written[at] = 0x2e
        written[at + 1] = 0x2e
      }
    }

    expect(await problemOf(readZip(written, codecs, LIMITS))).toBe('unsupported')
  })
})
