/**
 * The wrap documents of the payload-encryption key hierarchy (#302).
 *
 * Each project database carries its own data-encryption key (DEK) with it, wrapped once per
 * recipient: `key:<device kid>` for every member device and `key:escrow` for the server's escrow
 * key. The documents are project content — written by the creating client, replicated like any
 * other document — so a database that reaches a new device brings the means to open it, and a
 * local-only database is complete on its own (spec, "Wrap documents").
 *
 * The ids live outside the `device:` prefix range of `ids.ts` on purpose: `repository.list`
 * reads a ranged `_all_docs`, and the wraps must fall outside that range without any filter
 * existing — `keys.test.ts` pins the ordering. They are deliberately **not** a `DocumentType`:
 * no repository owns them, exports exclude them, and the only code that touches one is the
 * keyring in `ui/db/`.
 *
 * @module
 */

/** The id prefix of every wrap document, separator included. */
export const PROJECT_KEY_PREFIX = 'key:'

/** The fixed id of the escrow wrap: the DEK wrapped for the server's escrow public key. */
export const ESCROW_KEY_DOCUMENT_ID = 'key:escrow'

/**
 * One wrap: the project DEK, RSA-OAEP-encrypted for a single recipient.
 *
 * Add-only in normal operation — a new member means a new document, never an edit — which is
 * what keeps the wraps replication-conflict-free; revocation is a delete. The same shape serves
 * the device wraps and the escrow wrap: only the id and the recipient differ.
 */
export interface ProjectKeyDocument {
  /** `key:<recipient kid>` for a device wrap, {@link ESCROW_KEY_DOCUMENT_ID} for escrow. */
  readonly _id: string
  readonly _rev?: string
  readonly type: 'projectKey'
  /** The recipient's kid: SHA-256 of its SPKI, 64 lowercase hex chars (`deriveKid`). */
  readonly kid: string
  /** The one wrap algorithm this application speaks: RSA-OAEP with SHA-256 throughout. */
  readonly alg: 'RSA-OAEP-256'
  /** The DEK, wrapped with the recipient's public key; standard base64. */
  readonly wrapped: string
  readonly createdAt: string
}

/**
 * The id of a device's wrap document.
 *
 * @throws {RangeError} on an empty kid or one containing a colon — either would put the id
 *   outside the `key:` range, where {@link projectKeyRange} never finds it (the posture of
 *   `documentId` in `ids.ts`)
 */
export function projectKeyDocumentId(kid: string): string {
  if (kid === '') throw new RangeError('A wrap document id needs a kid; it must not be empty.')
  if (kid.includes(':')) {
    throw new RangeError(
      `A wrap document's kid must not contain a colon; received ${JSON.stringify(kid)}.`,
    )
  }
  return `${PROJECT_KEY_PREFIX}${kid}`
}

/**
 * The `_all_docs` bounds that cover every wrap document, escrow included.
 *
 * The same construction as `idRange`, with the same endkey convention — see
 * `HIGHEST_ID_CHARACTER` in `ids.ts` for why U+FFF0.
 */
export function projectKeyRange(): { readonly startkey: string; readonly endkey: string } {
  return { startkey: PROJECT_KEY_PREFIX, endkey: `${PROJECT_KEY_PREFIX}￰` }
}

/**
 * Whether a value read from a database is a wrap document.
 *
 * Checked by shape at the trust boundary, like `isProjectDocument`: these documents replicate,
 * so what comes back is whatever any member's client wrote. `alg` is strict — a wrap under an
 * algorithm this build does not speak must read as "no usable wrap", not as one that fails
 * later inside WebCrypto.
 */
export function isProjectKeyDocument(value: unknown): value is ProjectKeyDocument {
  if (typeof value !== 'object' || value === null) return false
  const document = value as Record<string, unknown>
  return (
    typeof document._id === 'string' &&
    document._id.startsWith(PROJECT_KEY_PREFIX) &&
    document.type === 'projectKey' &&
    typeof document.kid === 'string' &&
    document.alg === 'RSA-OAEP-256' &&
    typeof document.wrapped === 'string' &&
    typeof document.createdAt === 'string'
  )
}
