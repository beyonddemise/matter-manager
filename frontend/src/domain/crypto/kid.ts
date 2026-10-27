/**
 * Key identifiers for the payload-encryption key hierarchy.
 *
 * A *kid* names a public key everywhere keys are referred to — the device registration, the
 * `key:<kid>` wrap documents, escrow — and it is derived, never minted: SHA-256 over the raw
 * SPKI DER, written as the full 64 lowercase hex characters. Both ends derive it independently,
 * so the backend's `Envelope.kid` must produce the identical string from the identical bytes.
 *
 * F2 (#299) builds the rest of the WebCrypto envelope (`envelope.ts`) beside this module and
 * re-exposes `deriveKid` as part of its surface; its shared cross-platform vectors pin the
 * agreement with the backend. This module lands first because the device key (#300) needs it.
 *
 * Pure in the sense this layer requires: no I/O, no DOM, no imports. `SubtleCrypto.digest` is
 * deterministic computation available identically in every runtime this code meets (browsers,
 * workers, Node ≥ 20), but `tsconfig.domain.json` strips the DOM lib that would name it, so the
 * one method used is typed structurally below.
 *
 * @module
 */

/** The single WebCrypto operation this module performs, named without the DOM lib. */
interface Sha256 {
  digest(algorithm: 'SHA-256', data: Uint8Array): Promise<ArrayBuffer>
}

/** `crypto.subtle`, reached through `globalThis` because the DOM lib is absent here. */
function subtle(): Sha256 {
  return (globalThis as unknown as { crypto: { subtle: Sha256 } }).crypto.subtle
}

const BASE64_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'

/**
 * Standard base64 (RFC 4648 §4) → bytes.
 *
 * Hand-rolled rather than `atob`, which is a DOM global this layer does not have. Strict about
 * its input: a kid derived from a *mis-decoded* SPKI would be a stable, plausible-looking name
 * for a key nobody holds, so a character outside the alphabet throws instead of being skipped.
 */
function decodeBase64(value: string): Uint8Array {
  const unpadded = value.replace(/=+$/, '')
  const bytes = new Uint8Array(Math.floor((unpadded.length * 6) / 8))

  let buffer = 0
  let bits = 0
  let at = 0
  for (const character of unpadded) {
    const sextet = BASE64_ALPHABET.indexOf(character)
    if (sextet === -1) throw new Error('Not base64, so no key identifier can be derived from it.')
    buffer = (buffer << 6) | sextet
    bits += 6
    if (bits >= 8) {
      bits -= 8
      bytes[at] = (buffer >> bits) & 0xff
      at += 1
    }
  }
  return bytes
}

/** Bytes → lowercase hex, two characters per byte. */
function toHex(digest: ArrayBuffer): string {
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('')
}

/**
 * The key identifier for a public key: SHA-256 of the SPKI DER, full 64 lowercase hex chars.
 *
 * @param spkiB64 the SubjectPublicKeyInfo DER, standard base64 — exactly what
 *   `crypto.subtle.exportKey('spki', …)` yields once encoded, and what the API carries
 * @throws {Error} when the input is not base64 — see {@link decodeBase64} for why not lenient
 */
export async function deriveKid(spkiB64: string): Promise<string> {
  return toHex(await subtle().digest('SHA-256', decodeBase64(spkiB64)))
}
