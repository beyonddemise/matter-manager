/**
 * The one derivation from an email address to a user record's id.
 *
 * **There must be exactly one.** The record is keyed by address, so two derivations that differ
 * in a single detail (case, whitespace, padding, alphabet) give one person two records. Their
 * plan then appears and disappears depending on which code path read it, and nothing looks
 * wrong in either record.
 *
 * base64url rather than standard base64 because `/` in a document id has to be escaped in every
 * URL that names it, and `+` is read as a space by some decoders.
 *
 * @module
 */

/**
 * The record key for an address: trimmed, lower-cased, UTF-8, base64url without padding.
 *
 * @throws {TypeError} for an empty address, which would otherwise key every such caller to the
 *   same record.
 */
export function userKey(email: string): string {
  const normal = email.trim().toLowerCase()
  if (normal === '') throw new TypeError('An address is required to key a user record.')
  return Buffer.from(normal, 'utf8').toString('base64url')
}

/** The document id of the record for an address. */
export const userDocId = (email: string): string => `user:${userKey(email)}`
