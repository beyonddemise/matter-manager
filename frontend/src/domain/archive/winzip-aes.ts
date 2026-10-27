/**
 * WinZip AES encryption of one zip entry (AE-1 and AE-2), on WebCrypto: what a project export
 * with a password is sealed with (#307), and what an encrypted import is opened with.
 *
 * An entry's data becomes `salt ‖ verifier ‖ ciphertext ‖ mac`:
 *
 * - **Keys** come from PBKDF2-HMAC-SHA1 over the password (UTF-8) and a random salt (8, 12 or
 *   16 bytes for AES-128, -192, -256), at {@link AES_ITERATIONS} iterations. The output is the
 *   AES key, then an HMAC key of the same length, then a 2-byte password verifier.
 * - **Encryption** is AES in counter mode with WinZip's counter: a 128-bit *little-endian*
 *   integer starting at 1, which is not the big-endian counter WebCrypto's AES-CTR increments
 *   (see {@link keystream}).
 * - **Authentication** is HMAC-SHA1 over the ciphertext, cut to its first 10 bytes.
 *
 * The specification is WinZip's "AES Encryption Information: Encryption Specification AE-1 and
 * AE-2" (Brian Gladman's construction). The zip-level framing — method 99, the 0x9901 extra
 * field, AE-2's zeroed CRC — is `zip.ts`'s business; this module only seals and opens bytes.
 *
 * **The iteration count is 1000, and that is not a choice this code gets to make.** AE-1 and
 * AE-2 have no field for the count: every reader (7-Zip, WinZip, pyzipper, macOS archive tools)
 * derives keys at exactly 1000. A higher count would not be "stronger AE-2", it would be a
 * private format only this application opens, which defeats a zip backup's one advantage — that
 * it opens anywhere. 1000 rounds of SHA-1 cost an attacker almost nothing per guess, so the
 * password itself has to carry the strength; the export dialog enforces a minimum length for
 * exactly that reason (`ARCHIVE_PASSWORD_MIN_LENGTH`). Our importer reads what this writes by
 * construction, since both sides use this module.
 *
 * **What the password does not hide.** The zip's file names (`manifest.json`, `project.json`,
 * `devices/<uuid>.json`), the number of devices, the timestamps and each file's size stay
 * readable: zip encrypts contents, not the directory. The setup codes, names and everything else
 * inside the files are encrypted.
 *
 * Pure in the sense this layer requires: WebCrypto exists identically in every runtime this code
 * meets, but `tsconfig.domain.json` strips the DOM lib that would name it, so — like
 * `crypto/envelope.ts` — the operations used are typed structurally below.
 *
 * @module
 */

/** PBKDF2 iterations. Fixed by the WinZip specification; see the module comment. */
export const AES_ITERATIONS = 1000

/** The strength byte of the 0x9901 extra field, and what it means. */
export type AesStrength = 1 | 2 | 3

/** The strength this application writes: 3, AES-256. */
export const AES_256: AesStrength = 3

/** Salt bytes per strength; the key is twice as long. */
const SALT_LENGTH: Readonly<Record<AesStrength, number>> = { 1: 8, 2: 12, 3: 16 }
const VERIFIER_LENGTH = 2
const MAC_LENGTH = 10
const BLOCK = 16
/**
 * How many single-block encryptions run at once while building a key stream. Bounded so a
 * large entry does not queue hundreds of thousands of promises in one go.
 */
const BATCH = 4096

/** What sealing adds to an entry's (compressed) data, at a given strength. */
export function aesOverhead(strength: AesStrength): number {
  return SALT_LENGTH[strength] + VERIFIER_LENGTH + MAC_LENGTH
}

/** The platform's `CryptoKey`, which the missing DOM lib cannot name; opaque here. */
type Key = object

/** The WebCrypto operations this module performs, named without the DOM lib. */
interface Subtle {
  importKey(
    format: 'raw',
    keyData: Uint8Array,
    algorithm: 'PBKDF2' | { name: 'AES-CTR' } | { name: 'HMAC'; hash: 'SHA-1' },
    extractable: boolean,
    usages: ('deriveBits' | 'encrypt' | 'sign')[],
  ): Promise<Key>
  deriveBits(
    algorithm: { name: 'PBKDF2'; hash: 'SHA-1'; salt: Uint8Array; iterations: number },
    key: Key,
    length: number,
  ): Promise<ArrayBuffer>
  encrypt(
    algorithm: { name: 'AES-CTR'; counter: Uint8Array; length: number },
    key: Key,
    data: Uint8Array,
  ): Promise<ArrayBuffer>
  sign(algorithm: 'HMAC', key: Key, data: Uint8Array): Promise<ArrayBuffer>
}

type CryptoGlobals = {
  crypto: { subtle: Subtle; getRandomValues(target: Uint8Array): Uint8Array }
  TextEncoder: new () => { encode(text: string): Uint8Array }
}

function globals(): CryptoGlobals {
  return globalThis as unknown as CryptoGlobals
}

/** The three things PBKDF2 yields for one salt. */
interface Derived {
  readonly aes: Key
  readonly hmac: Key
  readonly verifier: Uint8Array
}

/** Derives the AES key, the HMAC key and the verifier from a password and a salt. */
async function derive(password: string, salt: Uint8Array, strength: AesStrength): Promise<Derived> {
  const { subtle } = globals().crypto
  const keyLength = SALT_LENGTH[strength] * 2
  const secret = await subtle.importKey(
    'raw',
    new (globals().TextEncoder)().encode(password),
    'PBKDF2',
    false,
    ['deriveBits'],
  )
  const bits = new Uint8Array(
    await subtle.deriveBits(
      { name: 'PBKDF2', hash: 'SHA-1', salt, iterations: AES_ITERATIONS },
      secret,
      (2 * keyLength + VERIFIER_LENGTH) * 8,
    ),
  )
  const [aes, hmac] = await Promise.all([
    subtle.importKey('raw', bits.slice(0, keyLength), { name: 'AES-CTR' }, false, ['encrypt']),
    subtle.importKey(
      'raw',
      bits.slice(keyLength, 2 * keyLength),
      { name: 'HMAC', hash: 'SHA-1' },
      false,
      ['sign'],
    ),
  ])
  return { aes, hmac, verifier: bits.slice(2 * keyLength) }
}

/**
 * XORs `data` with WinZip's key stream: AES of the counter blocks 1, 2, 3, … each written as a
 * 16-byte little-endian integer.
 *
 * Why one block per call: WebCrypto's AES-CTR increments its counter as a *big-endian* number,
 * so a single call over the whole entry would produce a different stream from the second block
 * on. Encrypting 16 zero bytes in CTR mode with the counter set to the block wanted yields
 * exactly AES(block), which is the stream. Batched, that measured about 0.35 s per MB of
 * compressed data (Node 24, Apple silicon); a project archive is a few hundred kilobytes, and
 * the 5 MB import limit bounds the worst case.
 */
async function keystream(key: Key, data: Uint8Array): Promise<Uint8Array> {
  const { subtle } = globals().crypto
  const out = new Uint8Array(data.length)
  const blocks = Math.ceil(data.length / BLOCK)
  const zero = new Uint8Array(BLOCK)
  for (let first = 0; first < blocks; first += BATCH) {
    const pending: Promise<ArrayBuffer>[] = []
    for (let index = first; index < Math.min(blocks, first + BATCH); index++) {
      const counter = new Uint8Array(BLOCK)
      // Blocks are numbered from 1. An entry is at most 4 GiB (no Zip64), so 4 bytes suffice.
      new DataView(counter.buffer).setUint32(0, index + 1, true)
      pending.push(subtle.encrypt({ name: 'AES-CTR', counter, length: 128 }, key, zero))
    }
    const streams = await Promise.all(pending)
    streams.forEach((stream, offset) => {
      const block = new Uint8Array(stream)
      const start = (first + offset) * BLOCK
      const end = Math.min(start + BLOCK, data.length)
      for (let at = start; at < end; at++) {
        out[at] = (data[at] as number) ^ (block[at - start] as number)
      }
    })
  }
  return out
}

/** The first {@link MAC_LENGTH} bytes of HMAC-SHA1 over `data`. */
async function mac(key: Key, data: Uint8Array): Promise<Uint8Array> {
  return new Uint8Array(await globals().crypto.subtle.sign('HMAC', key, data)).slice(0, MAC_LENGTH)
}

/** Whether two byte arrays are equal, looking at every byte whatever the first difference. */
function sameBytes(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false
  let difference = 0
  for (let at = 0; at < a.length; at++) difference |= (a[at] as number) ^ (b[at] as number)
  return difference === 0
}

/**
 * Seals one entry's (already compressed) data.
 *
 * @param password non-empty; encoded as UTF-8, which is what 7-Zip and pyzipper use
 * @param strength which AES key size; the application always writes {@link AES_256}
 * @returns `salt ‖ verifier ‖ ciphertext ‖ mac`, with a fresh random salt
 * @throws {RangeError} For an empty password, which would seal the entry for anyone.
 */
export async function sealAes(
  data: Uint8Array,
  password: string,
  strength: AesStrength = AES_256,
): Promise<Uint8Array> {
  if (password === '') throw new RangeError('An archive password must not be empty.')
  const salt = globals().crypto.getRandomValues(new Uint8Array(SALT_LENGTH[strength]))
  const keys = await derive(password, salt, strength)
  const ciphertext = await keystream(keys.aes, data)
  const code = await mac(keys.hmac, ciphertext)

  const out = new Uint8Array(salt.length + VERIFIER_LENGTH + ciphertext.length + MAC_LENGTH)
  out.set(salt, 0)
  out.set(keys.verifier, salt.length)
  out.set(ciphertext, salt.length + VERIFIER_LENGTH)
  out.set(code, out.length - MAC_LENGTH)
  return out
}

/** Why an entry could not be opened. `zip.ts` turns these into a `ZipError`. */
export type AesRefusal =
  /** The password verifier does not match: almost certainly the wrong password. */
  | 'wrongPassword'
  /** Too short to be sealed data, or the authentication code does not match: changed. */
  | 'tampered'

/**
 * Opens one sealed entry, checking the password verifier and then the authentication code
 * before anything is decrypted.
 *
 * The verifier is 2 bytes, so one wrong password in 65,536 passes it; the authentication code
 * then refuses it as `tampered`, and nothing wrong is ever returned as data.
 *
 * @returns the entry's (still compressed) data, or why not
 */
export async function openAes(
  sealed: Uint8Array,
  password: string,
  strength: AesStrength,
): Promise<Uint8Array | AesRefusal> {
  const saltLength = SALT_LENGTH[strength]
  if (sealed.length < aesOverhead(strength)) return 'tampered'
  const salt = sealed.subarray(0, saltLength)
  const verifier = sealed.subarray(saltLength, saltLength + VERIFIER_LENGTH)
  const ciphertext = sealed.subarray(saltLength + VERIFIER_LENGTH, sealed.length - MAC_LENGTH)
  const code = sealed.subarray(sealed.length - MAC_LENGTH)

  const keys = await derive(password, salt, strength)
  if (!sameBytes(keys.verifier, verifier)) return 'wrongPassword'
  if (!sameBytes(await mac(keys.hmac, ciphertext), code)) return 'tampered'
  return keystream(keys.aes, ciphertext)
}
