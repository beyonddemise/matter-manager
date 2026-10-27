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
 * Pure in the sense this layer requires: no I/O, no DOM, no imports from outside this directory.
 * `SubtleCrypto.digest` is deterministic computation available identically in every runtime this
 * code meets (browsers, workers, Node ≥ 20), but `tsconfig.domain.json` strips the DOM lib that
 * would name it, so the one method used is typed structurally below.
 *
 * @module
 */

import { decodeBase64 } from './base64.js'

/** The single WebCrypto operation this module performs, named without the DOM lib. */
interface Sha256 {
  digest(algorithm: 'SHA-256', data: Uint8Array): Promise<ArrayBuffer>
}

/** `crypto.subtle`, reached through `globalThis` because the DOM lib is absent here. */
function subtle(): Sha256 {
  return (globalThis as unknown as { crypto: { subtle: Sha256 } }).crypto.subtle
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
 * @throws {Error} when the input is not base64 — `base64.ts` explains why not lenient
 */
export async function deriveKid(spkiB64: string): Promise<string> {
  return toHex(await subtle().digest('SHA-256', decodeBase64(spkiB64)))
}
