/**
 * The zip container a project export is written in and an import is read from.
 *
 * Small on purpose, rather than a library (ADR 0013): it writes and reads exactly what the
 * project archive needs - stored and deflated entries, UTF-8 names, optionally WinZip AES
 * encrypted (AE-2 written, AE-1 and AE-2 read; `winzip-aes.ts`), no Zip64 - and refuses
 * everything else by name instead of guessing. Legacy ZipCrypto is never written and never
 * read: it is broken, and offering it would look like protection.
 *
 * **An encrypted archive is all or nothing.** Every file in it must be encrypted; one plain file
 * among encrypted ones is refused, because anybody could have added it without the password and
 * the import would restore it as part of a protected backup.
 *
 * **The compression is injected.** This package reaches for nothing ambient, so the deflate and
 * inflate it needs arrive as {@link ZipCodecs}; the web layer supplies the browser's
 * `CompressionStream`, and the tests Node's zlib, which also makes the tests an independent
 * check of the container.
 *
 * **Reading treats the file as hostile.** An imported zip came from somewhere else. The central
 * directory is what is trusted (it is what every unzip tool lists), sizes are checked against
 * {@link ZipLimits} before anything is inflated, inflating is capped again in the codec, every
 * CRC is verified, and a name that climbs out of the archive is refused.
 *
 * @module
 */

import { decodeUtf8, encodeUtf8 } from '../text/utf8.js'
import { AES_256, type AesStrength, aesOverhead, openAes, sealAes } from './winzip-aes.js'

/** Why an archive could not be read. A code, so the interface can translate it. */
export type ZipProblem =
  /** No end-of-central-directory record: not a zip at all, or cut short. */
  | 'notAZip'
  /** A zip, but using something this reader does not do: ZipCrypto, Zip64, another method. */
  | 'unsupported'
  /** AES encrypted, and no password was given: ask for one and read it again. */
  | 'needsPassword'
  /** AES encrypted, and the password given is not the one it was sealed with. */
  | 'wrongPassword'
  /**
   * A record points outside the file, an entry's CRC does not match its contents, or an
   * encrypted entry's authentication code does not match: it was changed after it was written.
   */
  | 'corrupt'
  /** Over one of the {@link ZipLimits}. */
  | 'tooLarge'

/** Thrown for an archive that cannot be read, with the reason as a {@link ZipProblem}. */
export class ZipError extends Error {
  override readonly name = 'ZipError'

  constructor(
    readonly problem: ZipProblem,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options)
  }
}

/** One file in an archive. */
export interface ZipEntry {
  /** The path inside the archive, `/`-separated. */
  readonly name: string
  readonly data: Uint8Array
}

/** Raw deflate (RFC 1951, no zlib or gzip wrapper), both ways. */
export interface ZipCodecs {
  deflate(data: Uint8Array): Promise<Uint8Array>
  /**
   * Inflates, and **stops at `limit` bytes** with a `ZipError('tooLarge')`.
   *
   * The cap belongs here as well as in the size check before it: the sizes an entry declares
   * are the attacker's to choose, and only the inflater sees what the data actually expands to.
   */
  inflate(data: Uint8Array, limit: number): Promise<Uint8Array>
}

/** How {@link writeZip} protects what it writes. */
export interface ZipWriteOptions {
  /**
   * Seals every entry with WinZip AES-256 (AE-2) under this password. Absent, the archive is
   * plain and byte-for-byte what it was before passwords existed.
   */
  readonly password?: string
}

/** What an archive may not exceed. */
export interface ZipLimits {
  /** The file itself. */
  readonly maxBytes: number
  /** Every entry inflated, added up. */
  readonly maxInflatedBytes: number
  readonly maxEntries: number
}

const LOCAL_HEADER = 0x04034b50
const CENTRAL_HEADER = 0x02014b50
const END_OF_CENTRAL_DIRECTORY = 0x06054b50
const LOCAL_HEADER_SIZE = 30
const CENTRAL_HEADER_SIZE = 46
const END_RECORD_SIZE = 22
/** The longest comment a zip may carry, so the end record is within this many bytes of the end. */
const MAX_COMMENT = 0xffff

const STORED = 0
const DEFLATED = 8
/** The method a WinZip AES entry declares; the real one is in its 0x9901 extra field. */
const AES_METHOD = 99
/** General purpose flags: bit 0 encrypted, bit 11 the name is UTF-8. */
const FLAG_ENCRYPTED = 0x0001
const FLAG_UTF8 = 0x0800
/** 2.0: deflate, and folders. What every unzip since the 1990s reads. */
const VERSION = 20
/** 5.1: the version needed the WinZip specification gives an AES entry. */
const VERSION_AES = 51
/** The WinZip AES extra field's header id, and its whole size: a 4-byte header, 7 of data. */
const AES_EXTRA_ID = 0x9901
const AES_EXTRA_SIZE = 11
/** "AE", the vendor id the AES extra field carries, as a little-endian 16-bit value. */
const AES_VENDOR = 0x4541
/** AE-2: no CRC is stored, so the archive does not carry a checksum of the plaintext. */
const AE_2 = 2

/** The CRC-32 table (reflected polynomial 0xEDB88320), built once. */
const CRC_TABLE = (() => {
  const table = new Uint32Array(256)
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    table[n] = c >>> 0
  }
  return table
})()

/** CRC-32 as zip uses it (ISO-HDLC): `crc32("123456789") === 0xCBF43926`. */
export function crc32(data: Uint8Array): number {
  let crc = 0xffffffff
  for (const byte of data) crc = (CRC_TABLE[(crc ^ byte) & 0xff] as number) ^ (crc >>> 8)
  return (crc ^ 0xffffffff) >>> 0
}

/** A date as the two 16-bit MS-DOS fields zip stores, in UTC so the result does not depend on where it ran. */
function dosDateTime(date: Date): { readonly time: number; readonly day: number } {
  const year = Math.max(1980, date.getUTCFullYear())
  return {
    time: (date.getUTCHours() << 11) | (date.getUTCMinutes() << 5) | (date.getUTCSeconds() >> 1),
    day: ((year - 1980) << 9) | ((date.getUTCMonth() + 1) << 5) | date.getUTCDate(),
  }
}

/** One entry as written: its compressed bytes and the facts both headers repeat. */
interface Prepared {
  readonly name: Uint8Array
  /** The method the data was compressed with (stored or deflated), sealed or not. */
  readonly method: number
  readonly encrypted: boolean
  readonly crc: number
  readonly body: Uint8Array
  readonly size: number
  readonly offset: number
}

/**
 * Writes entries into a zip.
 *
 * Each entry is deflated, or stored when deflating would not make it smaller (a one-byte file
 * grows). Names are written as UTF-8 and flagged so, which is what keeps `Küche.json` from
 * arriving as CP437 noise in another tool.
 *
 * @param entries the files, in the order they are to appear
 * @param codecs deflate (inflate is not used)
 * With a password, each entry's compressed data is sealed (`winzip-aes.ts`) under its own
 * random salt, declared as method 99 with the real method in a 0x9901 extra field, and its CRC
 * left 0 as AE-2 specifies. Two exports are then never byte-identical, by design.
 *
 * @param modified the timestamp every entry carries, so two plain exports of the same data at
 *   the same moment are byte-identical
 * @param options a password to encrypt with; none writes a plain archive
 * @throws {RangeError} If two entries share a name, which every reader resolves differently,
 *   or the password is empty.
 */
export async function writeZip(
  entries: readonly ZipEntry[],
  codecs: Pick<ZipCodecs, 'deflate'>,
  modified: Date,
  options: ZipWriteOptions = {},
): Promise<Uint8Array> {
  const { password } = options
  const names = new Set(entries.map((entry) => entry.name))
  if (names.size !== entries.length) {
    throw new RangeError('A zip must not hold two entries with the same name.')
  }

  const { time, day } = dosDateTime(modified)
  const prepared: Prepared[] = []
  let offset = 0
  for (const entry of entries) {
    const deflated = await codecs.deflate(entry.data)
    const store = deflated.length >= entry.data.length
    const name = encodeUtf8(entry.name)
    const compressed = store ? entry.data : deflated
    const encrypted = password !== undefined
    const body = encrypted ? await sealAes(compressed, password) : compressed
    prepared.push({
      name,
      method: store ? STORED : DEFLATED,
      encrypted,
      crc: encrypted ? 0 : crc32(entry.data),
      body,
      size: entry.data.length,
      offset,
    })
    offset += LOCAL_HEADER_SIZE + name.length + extraSize(encrypted) + body.length
  }

  const centralSize = prepared.reduce(
    (sum, entry) => sum + CENTRAL_HEADER_SIZE + entry.name.length + extraSize(entry.encrypted),
    0,
  )
  const out = new Uint8Array(offset + centralSize + END_RECORD_SIZE)
  const view = new DataView(out.buffer)

  /** The fields the local and central headers share, from `at` (version needed onwards). */
  const common = (at: number, entry: Prepared): void => {
    view.setUint16(at, entry.encrypted ? VERSION_AES : VERSION, true)
    view.setUint16(at + 2, entry.encrypted ? FLAG_UTF8 | FLAG_ENCRYPTED : FLAG_UTF8, true)
    view.setUint16(at + 4, entry.encrypted ? AES_METHOD : entry.method, true)
    view.setUint16(at + 6, time, true)
    view.setUint16(at + 8, day, true)
    view.setUint32(at + 10, entry.crc, true)
    view.setUint32(at + 14, entry.body.length, true)
    view.setUint32(at + 18, entry.size, true)
    view.setUint16(at + 22, entry.name.length, true)
    view.setUint16(at + 24, extraSize(entry.encrypted), true)
  }

  /** A sealed entry's AES extra field, at `at`; its last field is the real method. */
  const aesExtra = (at: number, entry: Prepared): void => {
    view.setUint16(at, AES_EXTRA_ID, true)
    view.setUint16(at + 2, AES_EXTRA_SIZE - 4, true)
    view.setUint16(at + 4, AE_2, true)
    view.setUint16(at + 6, AES_VENDOR, true)
    view.setUint8(at + 8, AES_256)
    view.setUint16(at + 9, entry.method, true)
  }

  for (const entry of prepared) {
    view.setUint32(entry.offset, LOCAL_HEADER, true)
    common(entry.offset + 4, entry)
    const nameAt = entry.offset + LOCAL_HEADER_SIZE
    out.set(entry.name, nameAt)
    if (entry.encrypted) aesExtra(nameAt + entry.name.length, entry)
    out.set(entry.body, nameAt + entry.name.length + extraSize(entry.encrypted))
  }

  let at = offset
  for (const entry of prepared) {
    view.setUint32(at, CENTRAL_HEADER, true)
    view.setUint16(at + 4, entry.encrypted ? VERSION_AES : VERSION, true) // version made by
    common(at + 6, entry)
    // Comment length, disk number and internal attributes stay 0.
    view.setUint32(at + 38, 0, true) // external attributes
    view.setUint32(at + 42, entry.offset, true)
    out.set(entry.name, at + CENTRAL_HEADER_SIZE)
    if (entry.encrypted) aesExtra(at + CENTRAL_HEADER_SIZE + entry.name.length, entry)
    at += CENTRAL_HEADER_SIZE + entry.name.length + extraSize(entry.encrypted)
  }

  view.setUint32(at, END_OF_CENTRAL_DIRECTORY, true)
  view.setUint16(at + 8, prepared.length, true)
  view.setUint16(at + 10, prepared.length, true)
  view.setUint32(at + 12, centralSize, true)
  view.setUint32(at + 16, offset, true)
  return out
}

/** The extra field a record carries: the AES one when sealed, none otherwise. */
const extraSize = (encrypted: boolean): number => (encrypted ? AES_EXTRA_SIZE : 0)

/** What an AES entry's 0x9901 extra field says. */
interface AesField {
  /** AE-1 keeps the CRC, AE-2 stores 0 instead. */
  readonly version: 1 | 2
  readonly strength: AesStrength
  /** The method the data was compressed with before it was sealed. */
  readonly method: number
}

/**
 * Finds and checks the 0x9901 field among a record's extra fields.
 *
 * @throws {ZipError} `unsupported` when there is none, or it says something this reader does
 *   not do: another vendor, a version other than AE-1 and AE-2, a strength other than 1-3.
 */
function aesField(view: DataView, start: number, length: number, name: string): AesField {
  const end = start + length
  for (let at = start; at + 4 <= end; ) {
    const id = view.getUint16(at, true)
    const size = view.getUint16(at + 2, true)
    if (id === AES_EXTRA_ID && size >= AES_EXTRA_SIZE - 4 && at + AES_EXTRA_SIZE <= end) {
      const version = view.getUint16(at + 4, true)
      const vendor = view.getUint16(at + 6, true)
      const strength = view.getUint8(at + 8)
      if (
        (version !== 1 && version !== 2) ||
        vendor !== AES_VENDOR ||
        (strength !== 1 && strength !== 2 && strength !== 3)
      ) {
        throw new ZipError('unsupported', `${name} uses an AES variant this reader does not know.`)
      }
      return { version, strength, method: view.getUint16(at + 9, true) }
    }
    at += 4 + size
  }
  throw new ZipError('unsupported', `${name} is encrypted, but not with WinZip AES.`)
}

/** Finds the end-of-central-directory record, searching back over a possible comment. */
function findEnd(view: DataView): number {
  const lowest = Math.max(0, view.byteLength - END_RECORD_SIZE - MAX_COMMENT)
  for (let at = view.byteLength - END_RECORD_SIZE; at >= lowest; at--) {
    if (view.getUint32(at, true) === END_OF_CENTRAL_DIRECTORY) return at
  }
  throw new ZipError(
    'notAZip',
    'The file has no zip end record; it is not a zip, or it is cut short.',
  )
}

/** Throws `corrupt` unless `[start, start + length)` lies inside the file. */
function within(view: DataView, start: number, length: number, what: string): void {
  if (start < 0 || length < 0 || start + length > view.byteLength) {
    throw new ZipError('corrupt', `The zip's ${what} points outside the file.`)
  }
}

/** Whether a name stays inside the archive: relative, no `..` segment, no backslash. */
function isSafeName(name: string): boolean {
  if (name === '' || name.startsWith('/') || name.includes('\\')) return false
  return !name.split('/').some((segment) => segment === '..')
}

/**
 * Reads every file out of a zip, verified.
 *
 * Folder entries (a name ending in `/`) are skipped: the paths of the files say everything.
 * An encrypted entry is opened with `password` before it is inflated, its authentication code
 * checked before anything is decrypted.
 *
 * @param bytes the whole file
 * @param codecs inflate (deflate is not used)
 * @param limits what the file may not exceed; checked before anything is inflated
 * @param password for an AES encrypted archive; a plain one ignores it
 * @throws {ZipError} For anything that is not a readable, intact archive within the limits:
 *   `needsPassword` for an encrypted one read without a password, `wrongPassword` for one read
 *   with another.
 */
export async function readZip(
  bytes: Uint8Array,
  codecs: Pick<ZipCodecs, 'inflate'>,
  limits: ZipLimits,
  password?: string,
): Promise<readonly ZipEntry[]> {
  if (bytes.length > limits.maxBytes) {
    throw new ZipError('tooLarge', `The file is over ${limits.maxBytes} bytes.`)
  }
  if (bytes.length < END_RECORD_SIZE) {
    throw new ZipError('notAZip', 'The file is too short to be a zip.')
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const end = findEnd(view)

  const count = view.getUint16(end + 10, true)
  const centralSize = view.getUint32(end + 12, true)
  const centralStart = view.getUint32(end + 16, true)
  // 0xFFFF / 0xFFFFFFFF in these fields mean "see the Zip64 record", which this does not read.
  if (count === 0xffff || centralStart === 0xffffffff) {
    throw new ZipError('unsupported', 'The zip uses Zip64, which this reader does not support.')
  }
  if (count > limits.maxEntries) {
    throw new ZipError('tooLarge', `The zip holds more than ${limits.maxEntries} files.`)
  }
  within(view, centralStart, centralSize, 'central directory')

  // Two passes: every record is read and every limit checked first, so an archive that is
  // over a limit is refused before a single byte of it is inflated.
  const planned: {
    readonly name: string
    readonly method: number
    readonly crc: number
    readonly size: number
    readonly body: Uint8Array
    /** A sealed entry's AES field. */
    readonly aes?: AesField
  }[] = []
  let declaredTotal = 0
  let at = centralStart
  for (let index = 0; index < count; index++) {
    within(view, at, CENTRAL_HEADER_SIZE, 'central directory')
    if (view.getUint32(at, true) !== CENTRAL_HEADER) {
      throw new ZipError('corrupt', 'The zip central directory is damaged.')
    }
    const flags = view.getUint16(at + 8, true)
    const method = view.getUint16(at + 10, true)
    const crc = view.getUint32(at + 16, true)
    const compressedSize = view.getUint32(at + 20, true)
    const size = view.getUint32(at + 24, true)
    const nameLength = view.getUint16(at + 28, true)
    const extraLength = view.getUint16(at + 30, true)
    const commentLength = view.getUint16(at + 32, true)
    const localOffset = view.getUint32(at + 42, true)
    within(view, at + CENTRAL_HEADER_SIZE, nameLength, 'file name')

    let name: string
    try {
      name = decodeUtf8(
        bytes.subarray(at + CENTRAL_HEADER_SIZE, at + CENTRAL_HEADER_SIZE + nameLength),
      )
    } catch (cause) {
      throw new ZipError('unsupported', 'A file name in the zip is not UTF-8.', { cause })
    }
    const extraStart = at + CENTRAL_HEADER_SIZE + nameLength
    within(view, extraStart, extraLength, 'extra field')
    at += CENTRAL_HEADER_SIZE + nameLength + extraLength + commentLength

    const encrypted = (flags & FLAG_ENCRYPTED) !== 0
    // Encrypted without method 99 is ZipCrypto, never read; method 99 unencrypted is nonsense.
    if (encrypted !== (method === AES_METHOD)) {
      throw new ZipError('unsupported', `${name} is encrypted with legacy ZipCrypto.`)
    }
    const aes = encrypted ? aesField(view, extraStart, extraLength, name) : undefined
    const compression = aes?.method ?? method
    if (compression !== STORED && compression !== DEFLATED) {
      throw new ZipError('unsupported', `${name} uses compression method ${compression}.`)
    }
    if (!isSafeName(name)) {
      throw new ZipError('unsupported', `${JSON.stringify(name)} is not a path inside the archive.`)
    }
    if (name.endsWith('/')) continue

    // What the entries *declare*, added up before anything is inflated; the codec enforces the
    // same cap on what they actually produce, since the declaration is the attacker's to write.
    declaredTotal += size
    if (declaredTotal > limits.maxInflatedBytes) {
      throw new ZipError(
        'tooLarge',
        `The zip's files add up to over ${limits.maxInflatedBytes} bytes.`,
      )
    }

    within(view, localOffset, LOCAL_HEADER_SIZE, 'file record')
    if (view.getUint32(localOffset, true) !== LOCAL_HEADER) {
      throw new ZipError('corrupt', `The record for ${name} is damaged.`)
    }
    const dataStart =
      localOffset +
      LOCAL_HEADER_SIZE +
      view.getUint16(localOffset + 26, true) +
      view.getUint16(localOffset + 28, true)
    within(view, dataStart, compressedSize, `data of ${name}`)
    if (aes !== undefined && compressedSize < aesOverhead(aes.strength)) {
      throw new ZipError('corrupt', `${name} is too short to be encrypted data.`)
    }
    planned.push({
      name,
      method: compression,
      crc,
      size,
      body: bytes.subarray(dataStart, dataStart + compressedSize),
      ...(aes === undefined ? {} : { aes }),
    })
  }

  const sealed = planned.filter((entry) => entry.aes !== undefined).length
  if (sealed > 0 && sealed < planned.length) {
    throw new ZipError('unsupported', 'The zip mixes encrypted and unencrypted files.')
  }
  if (sealed > 0 && (password === undefined || password === '')) {
    throw new ZipError('needsPassword', 'The zip is encrypted and needs its password.')
  }

  const entries: ZipEntry[] = []
  for (const { name, method, crc, size, body, aes } of planned) {
    const compressed = aes === undefined ? body : await open(body, password ?? '', aes, name)
    const data =
      method === STORED
        ? compressed.slice()
        : await codecs.inflate(compressed, limits.maxInflatedBytes)
    // AE-2 stores no CRC; its authentication code, checked already, stands in for it.
    const checksummed = aes === undefined || aes.version === 1
    if (data.length !== size || (checksummed && crc32(data) !== crc)) {
      throw new ZipError('corrupt', `${name} does not match its checksum.`)
    }
    entries.push({ name, data })
  }
  return entries
}

/** Opens one sealed entry, or throws why not as a {@link ZipError}. */
async function open(
  body: Uint8Array,
  password: string,
  aes: AesField,
  name: string,
): Promise<Uint8Array> {
  const opened = await openAes(body, password, aes.strength)
  if (opened === 'wrongPassword') {
    throw new ZipError('wrongPassword', 'The password does not open this zip.')
  }
  if (opened === 'tampered') {
    throw new ZipError('corrupt', `${name} was changed after it was encrypted.`)
  }
  return opened
}
