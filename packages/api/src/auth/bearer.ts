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
 * The signed-in subject, or `undefined` when the caller is not signed in.
 *
 * Every failure is the same answer — no header, a malformed one, a bad signature, an expired
 * token. The caller gets 401 and nothing else: which of those it was is a fact about the
 * credential somebody presented, and telling them narrows the search.
 *
 * @param key the key CouchDB also validates, because this reads an **access** token. A session
 *   is signed with a different one and is refused here on the signature.
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
