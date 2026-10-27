/**
 * The WebCrypto envelope for payload encryption (#299): the field cipher, the project DEK, and
 * the RSA wrap that moves a DEK between key holders.
 *
 * Three layers, exactly as the design records them:
 *
 * - **Fields** are AES-256-GCM with a fresh random 96-bit IV per encryption and the AAD
 *   `"<docId>:<fieldName>"`, stored as `enc:v1:<base64(iv ‖ ciphertext‖tag)>`. The AAD binds a
 *   ciphertext to its document *and* field, so values cannot be transplanted.
 * - **The DEK** is one AES-GCM 256 key per project, extractable because it must be wrappable —
 *   to the escrow key, to each member's device key.
 * - **Wrapping** is RSA-OAEP with SHA-256 for both the hash and MGF1 (WebCrypto's only reading;
 *   the backend passes an explicit `OAEPParameterSpec` to match).
 *
 * Cross-platform agreement with the backend's JCA `Envelope` is pinned by `vectors.json`, a
 * byte-identical copy of the backend's `src/test/resources/crypto-vectors.json`.
 * `test/domain/crypto/envelope.test.ts` re-derives every vector rather than trusting it
 * (lesson L1): two independent implementations agreeing over the same bytes is the anchor.
 *
 * Pure in the sense this layer requires: no I/O, no DOM, no imports from outside this directory.
 * WebCrypto, `TextEncoder` and `TextDecoder` exist identically in every runtime this code meets
 * (browsers, workers, Node ≥ 20), but `tsconfig.domain.json` strips the DOM lib that would name
 * them, so — following `kid.ts` — the handful of operations used are typed structurally below.
 *
 * @module
 */

import { decodeBase64, encodeBase64 } from './base64.js'

// deriveKid belongs to this surface (the kid names every wrap document), but landed first with
// the device key (#300); re-exposed here so envelope consumers import one module.
export { deriveKid } from './kid.js'

/**
 * Structural stand-in for the platform's `CryptoKey`, which the missing DOM lib cannot name.
 *
 * Deliberately the exact shape the DOM and Node both declare, so the two are mutually
 * assignable: a key minted by `crypto.subtle` in `ui/` (the device key) passes into this module,
 * and a DEK minted here passes back into raw WebCrypto calls, with no casts on either side.
 */
export interface CryptoKey {
  readonly algorithm: { name: string }
  readonly extractable: boolean
  readonly type: 'private' | 'public' | 'secret'
  readonly usages: KeyUsage[]
}

/** The platform's `KeyUsage` union, spelled out for the same reason {@link CryptoKey} is. */
type KeyUsage =
  | 'decrypt'
  | 'deriveBits'
  | 'deriveKey'
  | 'encrypt'
  | 'sign'
  | 'unwrapKey'
  | 'verify'
  | 'wrapKey'

/** The one AES algorithm this module speaks. */
type AesGcm = { name: 'AES-GCM'; length: 256 }

/** The WebCrypto operations this module performs, named without the DOM lib. */
interface Subtle {
  generateKey(algorithm: AesGcm, extractable: boolean, usages: KeyUsage[]): Promise<CryptoKey>
  encrypt(
    algorithm: { name: 'AES-GCM'; iv: Uint8Array; additionalData: Uint8Array },
    key: CryptoKey,
    data: Uint8Array,
  ): Promise<ArrayBuffer>
  decrypt(
    algorithm: { name: 'AES-GCM'; iv: Uint8Array; additionalData: Uint8Array },
    key: CryptoKey,
    data: Uint8Array,
  ): Promise<ArrayBuffer>
  importKey(
    format: 'spki',
    keyData: Uint8Array,
    algorithm: { name: 'RSA-OAEP'; hash: 'SHA-256' },
    extractable: boolean,
    usages: KeyUsage[],
  ): Promise<CryptoKey>
  wrapKey(
    format: 'raw',
    key: CryptoKey,
    wrappingKey: CryptoKey,
    wrapAlgorithm: { name: 'RSA-OAEP' },
  ): Promise<ArrayBuffer>
  unwrapKey(
    format: 'raw',
    wrappedKey: Uint8Array,
    unwrappingKey: CryptoKey,
    unwrapAlgorithm: { name: 'RSA-OAEP' },
    unwrappedKeyAlgorithm: AesGcm,
    extractable: boolean,
    usages: KeyUsage[],
  ): Promise<CryptoKey>
}

/** The globals this module reaches through `globalThis` because the DOM lib is absent here. */
type CryptoGlobals = {
  crypto: {
    subtle: Subtle
    getRandomValues(target: Uint8Array): Uint8Array
  }
  TextEncoder: new () => { encode(text: string): Uint8Array }
  TextDecoder: new (
    encoding: 'utf-8',
    options: { fatal: boolean },
  ) => { decode(bytes: Uint8Array): string }
}

function globals(): CryptoGlobals {
  return globalThis as unknown as CryptoGlobals
}

/** Any value carrying this prefix is (or claims to be) ciphertext, whatever the version. */
const ENCRYPTED_PREFIX = 'enc:'

/** The one format this module writes and reads: `enc:v1:<base64(iv ‖ ciphertext‖tag)>`. */
const FORMAT_PREFIX = 'enc:v1:'

/** 96-bit IV — GCM's native nonce size, fresh and random per encryption. */
const IV_BYTES = 12

const AES_GCM: AesGcm = { name: 'AES-GCM', length: 256 }

function utf8Encode(text: string): Uint8Array {
  return new (globals().TextEncoder)().encode(text)
}

/**
 * UTF-8, strictly: the bytes were authenticated by GCM, so anything that is not valid UTF-8 was
 * never written by {@link encryptField} — failing beats returning a mangled code.
 */
function utf8Decode(bytes: Uint8Array): string {
  return new (globals().TextDecoder)('utf-8', { fatal: true }).decode(bytes)
}

/**
 * The additional authenticated data binding a ciphertext to its document and field.
 *
 * DocIds legitimately contain colons (`device:<id>`), and that is safe *only* while the field
 * side is colon-free: the last colon then anchors the split, so no two (docId, field) pairs can
 * join into the same AAD. A colon in the field name would break that — `("device:a", "payload")`
 * and `("device", "a:payload")` would both read `device:a:payload`, and a ciphertext could be
 * transplanted between the two bindings. Shared by encrypt and decrypt, so both refuse it.
 *
 * @throws {Error} on a field name containing `:`
 */
function additionalData(docId: string, field: string): Uint8Array {
  if (field.includes(':')) {
    throw new Error(
      `Refusing the field name '${field}': a colon would make the "<docId>:<fieldName>" AAD ambiguous.`,
    )
  }
  return utf8Encode(`${docId}:${field}`)
}

/**
 * A fresh project DEK: AES-GCM 256.
 *
 * Extractable on purpose — a DEK exists to be wrapped (to the escrow key at project creation,
 * to each member's device key), and `wrapKey('raw', …)` refuses a non-extractable key. The
 * *device* key is the non-extractable one; the DEK's protection is that it only ever leaves a
 * browser wrapped.
 */
export async function generateDek(): Promise<CryptoKey> {
  return globals().crypto.subtle.generateKey(AES_GCM, true, ['encrypt', 'decrypt'])
}

/**
 * Encrypts one field value: `enc:v1:<base64(iv ‖ ciphertext‖tag)>`, AAD `"<docId>:<fieldName>"`.
 *
 * @throws {Error} when the value already carries the `enc:` prefix — double encryption is a
 *   programming error (a read path that failed to decrypt feeding a write path) and must fail
 *   loudly rather than corrupt the stored value — and on a field name containing `:`, which
 *   would make the AAD ambiguous (see {@link additionalData}; docId colons are fine, the field
 *   side anchors the split)
 */
export async function encryptField(
  dek: CryptoKey,
  docId: string,
  field: string,
  value: string,
): Promise<string> {
  if (value.startsWith(ENCRYPTED_PREFIX)) {
    throw new Error(
      `Refusing to encrypt ${docId}.${field}: the value is already in the '${ENCRYPTED_PREFIX}' format, and double encryption is a programming error.`,
    )
  }
  const { crypto } = globals()
  const iv = crypto.getRandomValues(new Uint8Array(IV_BYTES))
  const sealed = new Uint8Array(
    await crypto.subtle.encrypt(
      { name: 'AES-GCM', iv, additionalData: additionalData(docId, field) },
      dek,
      utf8Encode(value),
    ),
  )
  // iv ‖ ciphertext‖tag — WebCrypto appends the 16-byte GCM tag to the ciphertext itself.
  const packed = new Uint8Array(IV_BYTES + sealed.length)
  packed.set(iv)
  packed.set(sealed, IV_BYTES)
  return FORMAT_PREFIX + encodeBase64(packed)
}

/**
 * The inverse of {@link encryptField}, with two deliberate asymmetries:
 *
 * - A value **without** the `enc:` prefix passes through untouched. That is format-versioning
 *   headroom, not a migration mechanism — the server only ever holds ciphertext.
 * - A value with the prefix but an unknown version **throws**: handing ciphertext back as if it
 *   were the code would be silent corruption, and re-encrypting it is what the prefix check in
 *   {@link encryptField} refuses.
 *
 * @throws {Error} on an unknown `enc:` version, on a field name containing `:` (see
 *   {@link additionalData}), and whenever GCM authentication fails — a tampered ciphertext, the
 *   wrong DEK, or a ciphertext transplanted to another document or field (the AAD makes those
 *   the same failure)
 */
export async function decryptField(
  dek: CryptoKey,
  docId: string,
  field: string,
  stored: string,
): Promise<string> {
  if (!stored.startsWith(ENCRYPTED_PREFIX)) return stored
  if (!stored.startsWith(FORMAT_PREFIX)) {
    throw new Error(`Cannot decrypt ${docId}.${field}: unknown encrypted-field format version.`)
  }
  const packed = decodeBase64(stored.slice(FORMAT_PREFIX.length))
  const opened = await globals().crypto.subtle.decrypt(
    {
      name: 'AES-GCM',
      iv: packed.subarray(0, IV_BYTES),
      additionalData: additionalData(docId, field),
    },
    dek,
    packed.subarray(IV_BYTES),
  )
  return utf8Decode(new Uint8Array(opened))
}

/**
 * Wraps a DEK to a recipient's public key: RSA-OAEP, SHA-256 for both hash and MGF1.
 *
 * @param recipientSpkiB64 the recipient's SubjectPublicKeyInfo DER, standard base64 — the form
 *   device keys are registered in and `deriveKid` names
 * @returns the wrapped DEK, standard base64 — the `wrapped` of a `key:<kid>` document
 */
export async function wrapDek(dek: CryptoKey, recipientSpkiB64: string): Promise<string> {
  const { subtle } = globals().crypto
  const recipient = await subtle.importKey(
    'spki',
    decodeBase64(recipientSpkiB64),
    { name: 'RSA-OAEP', hash: 'SHA-256' },
    false,
    ['wrapKey'],
  )
  return encodeBase64(
    new Uint8Array(await subtle.wrapKey('raw', dek, recipient, { name: 'RSA-OAEP' })),
  )
}

/**
 * Opens a wrapped DEK with the holder's private key — the device key's `unwrapKey` usage.
 *
 * The unwrapped DEK comes back extractable, exactly like {@link generateDek}'s: the member who
 * unwraps it is the one who wraps it onward when the project gains a member or re-escrows.
 *
 * @throws {Error} when the wrap was not made to this private key (OAEP decryption fails)
 */
export async function unwrapDek(wrappedB64: string, privateKey: CryptoKey): Promise<CryptoKey> {
  return globals().crypto.subtle.unwrapKey(
    'raw',
    decodeBase64(wrappedB64),
    privateKey,
    { name: 'RSA-OAEP' },
    AES_GCM,
    true,
    ['encrypt', 'decrypt'],
  )
}
