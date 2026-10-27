import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { deflateRawSync, inflateRawSync } from 'node:zlib'
import { describe, expect, it } from 'vitest'
import { AES_ITERATIONS } from '../../../src/domain/archive/winzip-aes.js'
import {
  crc32,
  readZip,
  writeZip,
  type ZipCodecs,
  ZipError,
  type ZipLimits,
} from '../../../src/domain/archive/zip.js'

/**
 * The password-protected archive (#307): WinZip AE-2, AES-256-CTR with HMAC-SHA1, keys from
 * PBKDF2-HMAC-SHA1 at 1000 iterations.
 *
 * **The anchors are archives this code did not write (lesson L1).** A round trip through our
 * own writer and reader only proves the two agree with each other (lesson L16), so the reader
 * is first held to archives from two independent implementations, made on 2026-10-28 from the
 * same two files (`manifest.json`, 47 bytes; `devices/a.json`, "hello world " × 50) with the
 * password `correct horse battery`:
 *
 * - `PYZIPPER_AES256` / `PYZIPPER_AES128`: pyzipper 0.4.0 (Python 3.9),
 *   `AESZipFile(..., compression=ZIP_DEFLATED, encryption=WZ_AES)` with
 *   `setencryption(WZ_AES, nbits=256 | 128)`. Both entries AE-2, CRC field 0.
 * - `SEVEN_ZIP_AES256`: 7-Zip 26.05 (arm64, Homebrew `sevenzip`),
 *   `7zz a -tzip -mem=AES256 -mx=9 -mtc=off -p'correct horse battery'`. AE-2, version needed
 *   5.1. Its central records also carry an NTFS-time extra field *before* the AES one, so the
 *   extra-field walk is exercised rather than assumed.
 * - `SEVEN_ZIP_MIXED`: the 7-Zip archive with `devices/b.json` ("plain") then added by
 *   `7zz a -tzip -mx=0` without a password: one stored, unencrypted entry among AES ones.
 *
 * The other direction (what we write opens elsewhere) was checked by hand when this landed:
 * an export written with a password was listed and extracted by `7zz x` and by pyzipper. CI has
 * neither tool, so that check is recorded in the PR, and the structure it depends on is pinned
 * here field by field.
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
const PASSWORD = 'correct horse battery'
const MODIFIED = new Date('2026-10-19T14:59:00Z')

const text = (value: string): Uint8Array => new TextEncoder().encode(value)
const decode = (bytes: Uint8Array | undefined): string =>
  new TextDecoder().decode(bytes ?? new Uint8Array())
const base64 = (value: string): Uint8Array => new Uint8Array(Buffer.from(value, 'base64'))

const MANIFEST = '{"format":"matter-manager-project","version":1}'
const DEVICE = 'hello world '.repeat(50)

const PYZIPPER_AES256 =
  'UEsDBBQAAQBjAFwmXF0AAAAASgAAAC8AAAANAAsAbWFuaWZlc3QuanNvbgGZBwACAEFFAwgAqLuUy5TQSw3mKdNE3gm5H5+78CfVt+424V8Cld13mHUiUhLzLYfaShBHXsYrt3BmAkoW3x0+GSzpSgRI9X1pGjNlQvXtzKlO511QSwMEFAABAGMAXSZcXQAAAAAxAAAAWAIAAA4ACwBkZXZpY2VzL2EuanNvbgGZBwACAEFFAwgAFpuqCtiZv6PeyvlcjKYJpoCOJNCFj/0fUbCFFZKcstzxhlhuisD3JfullSffMN8pL1BLAQIUAxQAAQBjAFwmXF0AAAAASgAAAC8AAAANAAsAAAAAAAAAAACAAQAAAABtYW5pZmVzdC5qc29uAZkHAAIAQUUDCABQSwECFAMUAAEAYwBdJlxdAAAAADEAAABYAgAADgALAAAAAAAAAAAAgAGAAAAAZGV2aWNlcy9hLmpzb24BmQcAAgBBRQMIAFBLBQYAAAAAAgACAI0AAADoAAAAAAA='

const PYZIPPER_AES128 =
  'UEsDBBQAAQBjAF0mXF0AAAAAQgAAAC8AAAANAAsAbWFuaWZlc3QuanNvbgGZBwACAEFFAQgAXOiuREyYn7dh9ygpYj1toC9moG1kGocUg7ge5zwoTPg0JrAqLhklzdkykm+H+0XECQBe9F+EUtrECj1sovgxBpn2UEsDBBQAAQBjAF0mXF0AAAAAKQAAAFgCAAAOAAsAZGV2aWNlcy9hLmpzb24BmQcAAgBBRQEIALk8ciTf4VdFGtJPuzSGI1Gw/5Bjmq5Pudd+4hC25rBrJ3r0HvBffP8hUEsBAhQDFAABAGMAXSZcXQAAAABCAAAALwAAAA0ACwAAAAAAAAAAAIABAAAAAG1hbmlmZXN0Lmpzb24BmQcAAgBBRQEIAFBLAQIUAxQAAQBjAF0mXF0AAAAAKQAAAFgCAAAOAAsAAAAAAAAAAACAAXgAAABkZXZpY2VzL2EuanNvbgGZBwACAEFFAQgAUEsFBgAAAAACAAIAjQAAANgAAAAAAA=='

const SEVEN_ZIP_AES256 =
  'UEsDBDMAAQBjAGgmXF0AAAAAMAAAAFgCAAAOAAsAZGV2aWNlcy9hLmpzb24BmQcAAgBBRQMIAGaelr5BcXKZ3tCMfUl1pUie1ziizu4Xq5QMi0AgBs3/t1vHg3nkFbmhQ62Y+HV5c1BLAwQzAAEAYwBoJlxdAAAAAEoAAAAvAAAADQALAG1hbmlmZXN0Lmpzb24BmQcAAgBBRQMIACcK7v2mcWRQaasLE7rXDsbJAMKEujEfMQ9Dmwv0RyyEIUX8Y4F7tQzdi8KX/HPTRSSOndGXMkGUBPc9TWtKTY6N1XHz8M/qNW/CUEsBAj8DMwABAGMAaCZcXQAAAAAwAAAAWAIAAA4ALwAAAAAAAAAggKSBAAAAAGRldmljZXMvYS5qc29uCgAgAAAAAAABABgAsvEd6FRm3QEAAAAAAAAAAAAAAAAAAAAAAZkHAAIAQUUDCABQSwECPwMzAAEAYwBoJlxdAAAAAEoAAAAvAAAADQAvAAAAAAAAACCApIFnAAAAbWFuaWZlc3QuanNvbgoAIAAAAAAAAQAYACFmGOhUZt0BAAAAAAAAAAAAAAAAAAAAAAGZBwACAEFFAwgAUEsFBgAAAAACAAIA1QAAAOcAAAAAAA=='

const SEVEN_ZIP_MIXED =
  'UEsDBDMAAQBjAGgmXF0AAAAAMAAAAFgCAAAOAAsAZGV2aWNlcy9hLmpzb24BmQcAAgBBRQMIAGaelr5BcXKZ3tCMfUl1pUie1ziizu4Xq5QMi0AgBs3/t1vHg3nkFbmhQ62Y+HV5c1BLAwQKAAAAAACTJlxdz2IgGQUAAAAFAAAADgAAAGRldmljZXMvYi5qc29ucGxhaW5QSwMEMwABAGMAaCZcXQAAAABKAAAALwAAAA0ACwBtYW5pZmVzdC5qc29uAZkHAAIAQUUDCAAnCu79pnFkUGmrCxO61w7GyQDChLoxHzEPQ5sL9EcshCFF/GOBe7UM3YvCl/xz00Ukjp3RlzJBlAT3PU1rSk2OjdVx8/DP6jVvwlBLAQI/AzMAAQBjAGgmXF0AAAAAMAAAAFgCAAAOAC8AAAAAAAAAIICkgQAAAABkZXZpY2VzL2EuanNvbgoAIAAAAAAAAQAYALLxHehUZt0BAAAAAAAAAAAAAAAAAAAAAAGZBwACAEFFAwgAUEsBAj8DCgAAAAAAkyZcXc9iIBkFAAAABQAAAA4AJAAAAAAAAAAggKSBZwAAAGRldmljZXMvYi5qc29uCgAgAAAAAAABABgAhf9FGVVm3QEAAAAAAAAAAAAAAAAAAAAAUEsBAj8DMwABAGMAaCZcXQAAAABKAAAALwAAAA0ALwAAAAAAAAAggKSBmAAAAG1hbmlmZXN0Lmpzb24KACAAAAAAAAEAGAAhZhjoVGbdAQAAAAAAAAAAAAAAAAAAAAABmQcAAgBBRQMIAFBLBQYAAAAAAwADADUBAAAYAQAAAAA='

/**
 * What `writeZip` wrote for these two entries before #307, captured from `main` (dd69301) ahead
 * of any change: the no-password archive must stay byte-for-byte what it was.
 */
const PLAINTEXT_BEFORE_307 =
  'UEsDBBQAAAgAAGB3U12vrBtWBwAAAAcAAAANAAAAbWFuaWZlc3QuanNvbnsiYSI6MX1QSwMEFAAACAgAYHdTXVzHABAKAAAAWAIAAA8AAABkZXZpY2VzL8O8Lmpzb247vPLwKByFVIcAUEsBAhQAFAAACAAAYHdTXa+sG1YHAAAABwAAAA0AAAAAAAAAAAAAAAAAAAAAAG1hbmlmZXN0Lmpzb25QSwECFAAUAAAICABgd1NdXMcAEAoAAABYAgAADwAAAAAAAAAAAAAAAAAyAAAAZGV2aWNlcy/DvC5qc29uUEsFBgAAAAACAAIAeAAAAGkAAAAAAA=='

const problemOf = async (promise: Promise<unknown>): Promise<string | undefined> => {
  try {
    await promise
    return undefined
  } catch (error) {
    return error instanceof ZipError ? error.problem : `not a ZipError: ${String(error)}`
  }
}

/** Every central-directory record: where it is, and the fields the tests look at. */
function centralRecords(bytes: Uint8Array): {
  at: number
  flags: number
  method: number
  crc: number
  compressed: number
  size: number
  extra: Uint8Array
  name: string
}[] {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const records = []
  for (let at = 0; at + 46 <= bytes.length; at++) {
    if (view.getUint32(at, true) !== 0x02014b50) continue
    const nameLength = view.getUint16(at + 28, true)
    const extraLength = view.getUint16(at + 30, true)
    records.push({
      at,
      flags: view.getUint16(at + 8, true),
      method: view.getUint16(at + 10, true),
      crc: view.getUint32(at + 16, true),
      compressed: view.getUint32(at + 20, true),
      size: view.getUint32(at + 24, true),
      name: decode(bytes.subarray(at + 46, at + 46 + nameLength)),
      extra: bytes.slice(at + 46 + nameLength, at + 46 + nameLength + extraLength),
    })
  }
  return records
}

const hex = (bytes: Uint8Array): string => Buffer.from(bytes).toString('hex')

/** Flips the bits `mask` names in the byte at `at`. */
function flip(bytes: Uint8Array, at: number, mask: number): void {
  bytes[at] = (bytes[at] ?? 0) ^ mask
}

describe('reading AES archives other tools wrote', () => {
  it.each([
    ['pyzipper, AES-256', PYZIPPER_AES256],
    ['pyzipper, AES-128', PYZIPPER_AES128],
    ['7-Zip, AES-256', SEVEN_ZIP_AES256],
  ])('decrypts %s', async (_tool, archive) => {
    const entries = await readZip(base64(archive), codecs, LIMITS, PASSWORD)

    const byName = new Map(entries.map((entry) => [entry.name, decode(entry.data)]))
    expect(byName).toEqual(
      new Map([
        ['manifest.json', MANIFEST],
        ['devices/a.json', DEVICE],
      ]),
    )
  })

  it('decrypts an entry long enough to cross the key stream batch and every counter byte carry', async () => {
    // `fixtures/pyzipper-aes256-70k.zip`: pyzipper 0.4.0, one ZIP_STORED entry `random.bin`,
    // 70 000 bytes from Python's `random.Random(307).randbytes(70_000)`, AES-256, the same
    // password. 4375 cipher blocks: past 256 (the counter's first byte carries) and past the
    // 4096 blocks `winzip-aes.ts` encrypts per batch. Its SHA-256 was printed by the script.
    const bytes = new Uint8Array(
      readFileSync(new URL('./fixtures/pyzipper-aes256-70k.zip', import.meta.url)),
    )

    const [entry] = await readZip(bytes, codecs, LIMITS, PASSWORD)

    expect(entry?.name).toBe('random.bin')
    expect(
      createHash('sha256')
        .update(entry?.data ?? new Uint8Array())
        .digest('hex'),
    ).toBe('400c5a2946319aaa2588584e33bfe834f9870f2e442dd885a5882f57a47134e1')
  })

  it('asks for a password rather than calling an AES archive unsupported', async () => {
    expect(await problemOf(readZip(base64(SEVEN_ZIP_AES256), codecs, LIMITS))).toBe('needsPassword')
    expect(await problemOf(readZip(base64(PYZIPPER_AES256), codecs, LIMITS, ''))).toBe(
      'needsPassword',
    )
  })

  it('refuses a wrong password by name', async () => {
    expect(
      await problemOf(readZip(base64(PYZIPPER_AES256), codecs, LIMITS, 'correct horse batterY')),
    ).toBe('wrongPassword')
  })

  it('refuses an archive that mixes encrypted and plain files', async () => {
    // Anyone could add a plain file to a protected backup without knowing its password; the
    // import would then restore it as if it were protected.
    expect(await problemOf(readZip(base64(SEVEN_ZIP_MIXED), codecs, LIMITS, PASSWORD))).toBe(
      'unsupported',
    )
  })

  it('catches a changed byte of ciphertext through the authentication code', async () => {
    const bytes = base64(PYZIPPER_AES256)
    // The first entry's data starts after its 30-byte header, 13-byte name, 11-byte extra,
    // 16-byte salt and 2-byte verifier; flip a bit in the middle of the ciphertext.
    flip(bytes, 30 + 13 + 11 + 16 + 2 + 20, 0x01)

    expect(await problemOf(readZip(bytes, codecs, LIMITS, PASSWORD))).toBe('corrupt')
  })

  it('catches a changed authentication code', async () => {
    const bytes = base64(PYZIPPER_AES256)
    const [first] = centralRecords(bytes)
    const end = 30 + 13 + 11 + (first?.compressed ?? 0)
    flip(bytes, end - 1, 0x80)

    expect(await problemOf(readZip(bytes, codecs, LIMITS, PASSWORD))).toBe('corrupt')
  })

  it('checks the CRC of an AE-1 entry, which carries one', async () => {
    // AE-1 differs from AE-2 only in keeping the CRC; the authentication code covers the
    // ciphertext alone, so turning the anchor into AE-1 means setting both fields.
    const asAe1 = (crcOf: (name: string) => number): Uint8Array => {
      const bytes = base64(PYZIPPER_AES256)
      const view = new DataView(bytes.buffer)
      for (const record of centralRecords(bytes)) {
        view.setUint32(record.at + 16, crcOf(record.name), true)
        const extraStart = record.at + 46 + text(record.name).length
        view.setUint16(extraStart + 4, 1, true) // vendor version 1
      }
      return bytes
    }
    const real = (name: string) => crc32(text(name === 'manifest.json' ? MANIFEST : DEVICE))

    const entries = await readZip(asAe1(real), codecs, LIMITS, PASSWORD)
    expect(entries.map((entry) => decode(entry.data))).toEqual([MANIFEST, DEVICE])
    expect(
      await problemOf(
        readZip(
          asAe1((name) => real(name) ^ 1),
          codecs,
          LIMITS,
          PASSWORD,
        ),
      ),
    ).toBe('corrupt')
  })

  it('refuses an AES extra field it does not know', async () => {
    const withExtraByte = (offset: number, value: number): Uint8Array => {
      const bytes = base64(PYZIPPER_AES256)
      for (const record of centralRecords(bytes)) {
        bytes[record.at + 46 + text(record.name).length + offset] = value
      }
      return bytes
    }

    // Vendor version 3, vendor "AX", strength 4, and an actual method of bzip2.
    for (const [offset, value] of [
      [4, 3],
      [7, 0x58],
      [8, 4],
      [9, 12],
    ] as const) {
      expect(await problemOf(readZip(withExtraByte(offset, value), codecs, LIMITS, PASSWORD))).toBe(
        'unsupported',
      )
    }
  })

  it('refuses method 99 without its AES extra field', async () => {
    const bytes = base64(PYZIPPER_AES256)
    for (const record of centralRecords(bytes)) {
      // Rename the extra field's header id from 0x9901, so the record has no AES field.
      bytes[record.at + 46 + text(record.name).length] = 0x02
    }

    expect(await problemOf(readZip(bytes, codecs, LIMITS, PASSWORD))).toBe('unsupported')
  })

  it('refuses an entry too short to hold the salt, verifier and authentication code', async () => {
    const bytes = base64(PYZIPPER_AES256)
    const view = new DataView(bytes.buffer)
    for (const record of centralRecords(bytes)) view.setUint32(record.at + 20, 27, true)

    expect(await problemOf(readZip(bytes, codecs, LIMITS, PASSWORD))).toBe('corrupt')
  })
})

describe('writing with a password', () => {
  const entries = [
    { name: 'manifest.json', data: text('{"a":1}') },
    { name: 'devices/ü.json', data: text('é'.repeat(300)) },
    { name: 'empty.json', data: new Uint8Array() },
  ]

  it('uses the iteration count every AE-2 reader assumes', () => {
    // The format has no field for it: a reader cannot be told another count.
    expect(AES_ITERATIONS).toBe(1000)
  })

  it('round-trips through its own reader', async () => {
    const written = await writeZip(entries, codecs, MODIFIED, { password: 'Grüße, 1234 €' })

    const read = await readZip(written, codecs, LIMITS, 'Grüße, 1234 €')
    expect(read.map((entry) => [entry.name, decode(entry.data)])).toEqual(
      entries.map((entry) => [entry.name, decode(entry.data)]),
    )
  })

  it('cannot be read without the password, or with another', async () => {
    const written = await writeZip(entries, codecs, MODIFIED, { password: PASSWORD })

    expect(await problemOf(readZip(written, codecs, LIMITS))).toBe('needsPassword')
    expect(await problemOf(readZip(written, codecs, LIMITS, `${PASSWORD}!`))).toBe('wrongPassword')
  })

  it('writes the WinZip AE-2 layout other tools read', async () => {
    const written = await writeZip(
      [
        { name: 'a.json', data: text('hello world '.repeat(50)) },
        { name: 'x', data: text('x') },
      ],
      codecs,
      MODIFIED,
      { password: PASSWORD },
    )
    const view = new DataView(written.buffer, written.byteOffset, written.byteLength)
    const [deflated, stored] = centralRecords(written)

    for (const record of [deflated, stored]) {
      expect(record?.flags).toBe(0x0801) // encrypted, UTF-8 name
      expect(record?.method).toBe(99)
      expect(record?.crc).toBe(0) // AE-2 stores no CRC: it would leak a hash of the plaintext
      expect(view.getUint16((record?.at ?? 0) + 6, true)).toBe(51) // version needed 5.1
    }
    // Header 0x9901, 7 bytes: vendor version 2 (AE-2), "AE", strength 3 (AES-256), then the
    // method the data was compressed with.
    expect(hex(deflated?.extra ?? new Uint8Array())).toBe('0199070002004145030800')
    expect(hex(stored?.extra ?? new Uint8Array())).toBe('0199070002004145030000')
    // Salt 16, verifier 2, ciphertext as long as the compressed data, authentication code 10.
    expect(stored?.compressed).toBe(16 + 2 + 1 + 10)
    expect(stored?.size).toBe(1)
    // The local header repeats method, flags, sizes and the extra field.
    expect(view.getUint16(6, true)).toBe(0x0801)
    expect(view.getUint16(8, true)).toBe(99)
    expect(view.getUint16(28, true)).toBe(11)
    expect(hex(written.subarray(30 + 6, 30 + 6 + 11))).toBe('0199070002004145030800')
  })

  it('salts every entry afresh, so no two share a key stream', async () => {
    const same = text('the same bytes, twice')
    const written = await writeZip(
      [
        { name: 'one', data: same },
        { name: 'two', data: same },
      ],
      codecs,
      MODIFIED,
      { password: PASSWORD },
    )
    const view = new DataView(written.buffer)
    const body = (at: number): Uint8Array => {
      const nameLength = view.getUint16(at + 26, true)
      const extraLength = view.getUint16(at + 28, true)
      const start = at + 30 + nameLength + extraLength
      return written.slice(start, start + view.getUint32(at + 18, true))
    }
    const [one, two] = centralRecords(written).map((record) =>
      body(view.getUint32(record.at + 42, true)),
    )
    const first = one ?? new Uint8Array()
    const second = two ?? new Uint8Array()

    expect(first.length).toBe(16 + 2 + same.length + 10)
    expect(hex(first.subarray(0, 16))).not.toBe(hex(second.subarray(0, 16)))
    expect(hex(first.subarray(18))).not.toBe(hex(second.subarray(18)))
  })

  it('refuses an empty password rather than writing an archive anyone opens', async () => {
    await expect(writeZip(entries, codecs, MODIFIED, { password: '' })).rejects.toThrow(RangeError)
  })
})

describe('writing without a password', () => {
  it('writes exactly the archive it wrote before passwords existed', async () => {
    const two = [
      { name: 'manifest.json', data: text('{"a":1}') },
      { name: 'devices/ü.json', data: text('é'.repeat(300)) },
    ]

    expect(Buffer.from(await writeZip(two, codecs, MODIFIED)).toString('base64')).toBe(
      PLAINTEXT_BEFORE_307,
    )
    expect(Buffer.from(await writeZip(two, codecs, MODIFIED, {})).toString('base64')).toBe(
      PLAINTEXT_BEFORE_307,
    )
  })

  it('reads a plain archive whether or not a password is offered', async () => {
    const plain = base64(PLAINTEXT_BEFORE_307)

    expect(await readZip(plain, codecs, LIMITS, 'unused')).toHaveLength(2)
  })
})
