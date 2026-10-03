/**
 * Reading the caller's identity from an `Authorization: Bearer` header.
 *
 * **Which credential authorises what, in one sentence:** the `mm_handoff` cookie authorises only
 * the first `POST /auth/token` after a sign-in, and everything else takes the access token. The
 * cookie is httpOnly, two minutes long and single use, so it exists to get the first tokens; the
 * access token is what the page can actually send — to CouchDB, and to this service — and it is
 * the same token, verified with the same key, because CouchDB validates it for itself (M4-4).
 * The refresh token travels in a request body to `/auth/*` only, and is signed with a key this
 * function never verifies against.
 *
 * That rule is what `openapi.yaml` declares with a global `security: bearerAuth`.
 *
 * @module
 */

import type { FastifyRequest } from 'fastify'
import type { DenyList } from './deny-list.js'
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
 * The verified claims of the caller's access token, or `undefined`. A denied token is refused
 * exactly like a forged one: telling them apart would tell a thief their copy had been noticed.
 *
 * Every failure is the same answer — no header, a malformed one, a bad signature, an expired or
 * denied token. The caller gets 401 and nothing else: which of those it was is a fact about the
 * credential somebody presented, and telling them narrows the search.
 *
 * @param key the key CouchDB also validates, because this reads an **access** token. A refresh
 *   token or handoff is signed with a different one and is refused here on the signature.
 * @param deny tokens signed out before their expiry. Optional only while callers migrate; it
 *   protects this API, not CouchDB, which never asks (see `deny-list.ts`).
 */
export function bearerClaims(
  request: FastifyRequest,
  key: SigningKey,
  now: () => number,
  deny?: DenyList,
): { readonly sub: string; readonly email?: string; readonly name?: string } | undefined {
  const token = bearerToken(request.headers.authorization)
  if (token === undefined) return undefined
  try {
    const claims = verifyToken(token, key.publicKey, 'access', now)
    if (claims.jti !== undefined && deny?.denied(claims.jti) === true) return undefined
    return {
      sub: claims.sub,
      ...(claims.email === undefined ? {} : { email: claims.email }),
      ...(claims.name === undefined ? {} : { name: claims.name }),
    }
  } catch {
    return undefined
  }
}

/** The signed-in subject, or `undefined` when the caller is not signed in. See {@link bearerClaims}. */
export function bearerSubject(
  request: FastifyRequest,
  key: SigningKey,
  now: () => number,
  deny?: DenyList,
): string | undefined {
  return bearerClaims(request, key, now, deny)?.sub
}
