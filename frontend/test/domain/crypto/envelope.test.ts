import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import {
  decryptField,
  deriveKid,
  encryptField,
  generateDek,
  unwrapDek,
  wrapDek,
} from '../../../src/domain/crypto/envelope.js'

/**
 * The WebCrypto envelope (#299), pinned against the shared cross-platform fixture.
 *
 * `vectors.json` is a byte-identical copy of the backend's
 * `src/test/resources/crypto-vectors.json`. Per lesson L1 the fixture is never *trusted*: every
 * vector is re-derived here — the wrap is opened with the fixture private key and must yield
 * the fixture DEK, the GCM ciphertext is opened with the fixture key/iv/aad and must yield the
 * fixture plaintext, and the kid is re-derived from the fixture SPKI. The backend's JCA
 * implementation performs the same re-derivations over the same bytes, so two independent
 * implementations agreeing on them is the anchor (lesson L16: a round trip alone proves only
 * self-consistency).
 *
 * All byte plumbing in this file goes through `Buffer`, not through the module's own base64 —
 * the test must stay an independent witness of the encoding as well as of the cryptography.
 */

type Vectors = {
  comment: string
  rsa: { publicKeySpki: string; privateKeyPkcs8: string; kid: string; dek: string; wrapped: string }
  gcm: { key: string; iv: string; aad: string; plaintext: string; ciphertext: string }
}

const vectors: Vectors = JSON.parse(
  readFileSync(
    join(dirname(fileURLToPath(import.meta.url)), '../../../src/domain/crypto/vectors.json'),
    'utf8',
  ),
)

// Uint8Array.from copies the Buffer into a plain ArrayBuffer-backed view, which is what the
// WebCrypto signatures want (a Buffer is typed over ArrayBufferLike, not BufferSource).
const bytes = (b64: string): Uint8Array<ArrayBuffer> => Uint8Array.from(Buffer.from(b64, 'base64'))

/** The fixture's AES key, imported for use with `decryptField`. */
function fixtureGcmKey(): Promise<CryptoKey> {
  return crypto.subtle.importKey('raw', bytes(vectors.gcm.key), 'AES-GCM', false, ['decrypt'])
}

/** The fixture's RSA private key — the one the fixture's `wrapped` was wrapped to. */
function fixturePrivateKey(): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    'pkcs8',
    bytes(vectors.rsa.privateKeyPkcs8),
    { name: 'RSA-OAEP', hash: 'SHA-256' },
    false,
    ['unwrapKey'],
  )
}

describe('encryptField / decryptField', () => {
  it('fieldRoundTrips — what encryptField stores, decryptField returns verbatim', async () => {
    const dek = await generateDek()
    const stored = await encryptField(dek, 'device:42', 'payload', 'MT:Y.K90SO527JA0648G00')

    expect(stored).toMatch(/^enc:v1:[A-Za-z0-9+/]+=*$/)
    expect(await decryptField(dek, 'device:42', 'payload', stored)).toBe('MT:Y.K90SO527JA0648G00')
  })

  it('packs exactly iv ‖ ciphertext‖tag, decryptable by an independent implementation', async () => {
    // Anchor for the *encrypt* direction (lesson L16): the stored bytes are opened with raw
    // WebCrypto here, not with decryptField, so an encode/decode error cannot cancel out.
    const dek = await crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, true, [
      'encrypt',
      'decrypt',
    ])
    const stored = await encryptField(dek, 'device:7', 'manualCode', '34970112332')

    const packed = bytes(stored.slice('enc:v1:'.length))
    // 96-bit IV, then the ciphertext with its 16-byte GCM tag appended.
    expect(packed.length).toBe(12 + '34970112332'.length + 16)
    const opened = await crypto.subtle.decrypt(
      {
        name: 'AES-GCM',
        iv: packed.subarray(0, 12),
        additionalData: new TextEncoder().encode('device:7:manualCode'),
      },
      dek,
      packed.subarray(12),
    )
    expect(new TextDecoder().decode(opened)).toBe('34970112332')
  })

  it('uses a fresh IV per encryption, so equal values never store equal bytes', async () => {
    const dek = await generateDek()
    const first = await encryptField(dek, 'device:1', 'payload', 'same value')
    const second = await encryptField(dek, 'device:1', 'payload', 'same value')
    expect(first).not.toBe(second)
    expect(bytes(first.slice('enc:v1:'.length)).subarray(0, 12)).not.toEqual(
      bytes(second.slice('enc:v1:'.length)).subarray(0, 12),
    )
  })

  it('wrongAadFailsToDecrypt — a ciphertext cannot be transplanted to another document', async () => {
    const dek = await generateDek()
    const stored = await encryptField(dek, 'device:original', 'payload', 'bound value')
    await expect(decryptField(dek, 'device:other', 'payload', stored)).rejects.toThrow()
  })

  it('wrongAadFailsToDecrypt — nor to another field of the same document', async () => {
    // "Immutable means no edit *and* no delete" (lesson L13): the AAD binds docId AND field,
    // so each half must be shown load-bearing separately.
    const dek = await generateDek()
    const stored = await encryptField(dek, 'device:original', 'payload', 'bound value')
    await expect(decryptField(dek, 'device:original', 'manualCode', stored)).rejects.toThrow()
  })

  it('plaintextPassesThrough — a value without the enc: prefix is returned untouched', async () => {
    const dek = await generateDek()
    expect(await decryptField(dek, 'device:42', 'payload', 'MT:PLAINCODE')).toBe('MT:PLAINCODE')
    expect(await decryptField(dek, 'device:42', 'payload', '')).toBe('')
  })

  it('doubleEncryptThrows — encrypting an already-encrypted value fails loudly', async () => {
    const dek = await generateDek()
    const stored = await encryptField(dek, 'device:42', 'payload', 'once is enough')
    await expect(encryptField(dek, 'device:42', 'payload', stored)).rejects.toThrow(
      /double encryption/i,
    )
    // Any enc:-prefixed input is refused, not only the current version's format.
    await expect(encryptField(dek, 'device:42', 'payload', 'enc:v9:AAAA')).rejects.toThrow()
  })

  it('refuses an enc:-prefixed value of a format version it does not know', async () => {
    // Pass-through is headroom for *plaintext*, not a licence to hand ciphertext back as if
    // it were the code: an unknown enc: version must fail, never leak through.
    const dek = await generateDek()
    await expect(decryptField(dek, 'device:42', 'payload', 'enc:v2:AAAA')).rejects.toThrow()
  })
})

describe('wrapDek / unwrapDek', () => {
  it('wrapRoundTrips — a DEK wrapped to a recipient decrypts their fields again', async () => {
    const pair = await crypto.subtle.generateKey(
      {
        name: 'RSA-OAEP',
        modulusLength: 3072,
        publicExponent: new Uint8Array([0x01, 0x00, 0x01]),
        hash: 'SHA-256',
      },
      false,
      ['wrapKey', 'unwrapKey'],
    )
    const spkiB64 = Buffer.from(await crypto.subtle.exportKey('spki', pair.publicKey)).toString(
      'base64',
    )

    const dek = await generateDek()
    const stored = await encryptField(dek, 'device:9', 'payload', 'MT:SHARED')

    const unwrapped = await unwrapDek(await wrapDek(dek, spkiB64), pair.privateKey)
    expect(await decryptField(unwrapped, 'device:9', 'payload', stored)).toBe('MT:SHARED')
  })

  it('stays wrappable after an unwrap, so a recipient can wrap it onward', async () => {
    const dek = await generateDek()
    const unwrapped = await unwrapDek(
      await wrapDek(dek, vectors.rsa.publicKeySpki),
      await fixturePrivateKey(),
    )
    // Re-wrapping (sharing with the next member, re-escrow) needs the unwrapped key to be
    // extractable; a key that cannot leave as 'raw' cannot be wrapped either.
    await expect(wrapDek(unwrapped, vectors.rsa.publicKeySpki)).resolves.toMatch(
      /^[A-Za-z0-9+/]+=*$/,
    )
  })
})

describe('the shared cross-platform vectors, re-derived (lesson L1)', () => {
  it('kidMatchesVector — deriveKid over the fixture SPKI yields the fixture kid', async () => {
    expect(vectors.rsa.kid).toMatch(/^[0-9a-f]{64}$/)
    expect(await deriveKid(vectors.rsa.publicKeySpki)).toBe(vectors.rsa.kid)
  })

  it('opens the fixture wrap with the fixture private key and finds the fixture DEK', async () => {
    const unwrapped = await unwrapDek(vectors.rsa.wrapped, await fixturePrivateKey())
    const raw = Buffer.from(await crypto.subtle.exportKey('raw', unwrapped))
    expect(raw.equals(Buffer.from(vectors.rsa.dek, 'base64'))).toBe(true)
  })

  it('wraps the fixture DEK to the fixture public key, and the wrap opens again', async () => {
    // RSA-OAEP is randomised, so the fixture's `wrapped` bytes cannot be reproduced — but a
    // wrap produced *here* must open under the fixture private key, which is exactly the
    // interop the backend asserts from the other side.
    const dek = await crypto.subtle.importKey('raw', bytes(vectors.rsa.dek), 'AES-GCM', true, [
      'encrypt',
      'decrypt',
    ])
    const reopened = await unwrapDek(
      await wrapDek(dek, vectors.rsa.publicKeySpki),
      await fixturePrivateKey(),
    )
    const raw = Buffer.from(await crypto.subtle.exportKey('raw', reopened))
    expect(raw.equals(Buffer.from(vectors.rsa.dek, 'base64'))).toBe(true)
  })

  it('opens the fixture GCM ciphertext through decryptField itself', async () => {
    // The fixture AAD is the exact "<docId>:<fieldName>" shape, so the module's own read path
    // can open it: iv ‖ ciphertext‖tag packed as a stored field, AAD "escrow:keys".
    expect(Buffer.from(vectors.gcm.aad, 'base64').toString('utf8')).toBe('escrow:keys')

    const iv = bytes(vectors.gcm.iv)
    const ciphertext = bytes(vectors.gcm.ciphertext)
    expect(iv.length).toBe(12)

    const packed = new Uint8Array(iv.length + ciphertext.length)
    packed.set(iv)
    packed.set(ciphertext, iv.length)
    const stored = `enc:v1:${Buffer.from(packed).toString('base64')}`

    expect(await decryptField(await fixtureGcmKey(), 'escrow', 'keys', stored)).toBe(
      Buffer.from(vectors.gcm.plaintext, 'base64').toString('utf8'),
    )
  })

  it('the fixture ciphertext carries its 16-byte GCM tag', () => {
    expect(bytes(vectors.gcm.ciphertext).length).toBe(bytes(vectors.gcm.plaintext).length + 16)
  })
})
