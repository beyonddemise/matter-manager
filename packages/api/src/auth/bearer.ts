/**
 * Reading the caller's identity from an `Authorization: Bearer` header.
 *
 * **Which credential authorises what, in one sentence:** the `mm_session` cookie authorises the
 * `/auth/*` endpoints, and everything else takes the access token. The cookie is httpOnly and
 * `SameSite=Lax`, so it exists to get a token; the token is what the page can actually send —
 * to CouchDB, and to this service — and it is the same token, verified with the same key,
 * because CouchDB validates it for itself (M4-4).
 *
 * That rule is what `openapi/matter-manager.yaml` declares with a global `security: bearerAuth`.
 *
 * @module
 */

import type { FastifyRequest } from 'fastify'
import { type SigningKey, verifyToken } from './jwt.js'

/** The scheme, lower-cased for comparison. Header values are not case-sensitive here. */
const SCHEME = 'bearer'

/**
 * The token in an `Authorization` header, or `undefined` if there is none to read.
 *
 * Deliberately strict about the shape: exactly one space, exactly the `Bearer` scheme. A parser
 * that accepted `Bearer` with trailing junk, or several tokens, would be deciding which one
 * counts — and that decision belongs nowhere.
 */
export function bearerToken(header: string | undefined): string | undefined {
  if (header === undefined) return undefined

  const [scheme, ...rest] = header.split(' ')
  if (scheme?.toLowerCase() !== SCHEME || rest.length !== 1) return undefined

  const token = rest[0]
  return token === undefined || token === '' ? undefined : token
}

/**
 * Extracts and verifies the subject from an access token in the request's authorization header.
 *
 * @param request - The request containing the authorization header
 * @param key - The signing key used to verify the token
 * @param now - Supplies the current time for token validation
 * @returns The token subject, or `undefined` if the header is missing or malformed, or the token is invalid or expired
 */
export function bearerSubject(
  request: FastifyRequest,
  key: SigningKey,
  now: () => number,
): string | undefined {
  const token = bearerToken(request.headers.authorization)
  if (token === undefined) return undefined

  try {
    return verifyToken(token, key.publicKey, 'access', now).sub
  } catch {
    return undefined
  }
}
