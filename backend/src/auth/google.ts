/**
 * Google, as a {@link Provider}, and the ID-token verification that goes with it.
 *
 * Google signs ID tokens with **RS256** and publishes its keys as JWKS. Importing one of those
 * keys is the line that usually motivates adding `jose`:
 *
 * ```js
 * createPublicKey({ key: jwk, format: 'jwk' })
 * ```
 *
 * That is the whole of it (ADR 0013).
 *
 * **On whether the signature needs checking at all.** OpenID Connect Core §3.1.3.7 permits a
 * client that obtained the ID token by direct communication with the token endpoint to rely on
 * TLS server validation instead. That would be defensible and would remove this file's network
 * call. It is checked anyway: the cost is one cached fetch, and the alternative makes the
 * correctness of every sign-in depend on nothing between here and Google ever mis-validating a
 * certificate. For an application holding the commissioning codes to somebody's home, the
 * cheaper assumption is not the better one.
 *
 * @module
 */

import { createPublicKey, createVerify, type KeyObject } from 'node:crypto'
import { type Identity, identityFrom, type Provider, SignInError } from './oidc.js'

/**
 * Google's endpoints.
 *
 * Written down rather than discovered at startup. The discovery document is the more correct
 * source, and fetching it makes this service refuse to start when Google is briefly unreachable
 * — trading a rare, silent staleness for a common, loud outage. These values have been stable
 * for years; a change would be announced long before it shipped.
 *
 * https://accounts.google.com/.well-known/openid-configuration
 */
export const GOOGLE_ENDPOINTS = {
  authorizationEndpoint: 'https://accounts.google.com/o/oauth2/v2/auth',
  tokenEndpoint: 'https://oauth2.googleapis.com/token',
  jwksUri: 'https://www.googleapis.com/oauth2/v3/certs',
  issuers: ['https://accounts.google.com', 'accounts.google.com'],
} as const

/** Builds the Google provider from configuration. */
export function googleProvider(config: {
  readonly clientId: string
  readonly clientSecret: string
  readonly redirectUri: string
}): Provider {
  return {
    name: 'google',
    authorizationEndpoint: GOOGLE_ENDPOINTS.authorizationEndpoint,
    tokenEndpoint: GOOGLE_ENDPOINTS.tokenEndpoint,
    jwksUri: GOOGLE_ENDPOINTS.jwksUri,
    clientId: config.clientId,
    clientSecret: config.clientSecret,
    redirectUri: config.redirectUri,
    // `openid` for the ID token, `email` and `profile` for a name to show beside a remark.
    // Nothing else: every extra scope is a consent screen that asks for more than it needs.
    scopes: ['openid', 'email', 'profile'],
  }
}

/** A JSON Web Key Set, as far as this file reads one. */
interface Jwks {
  readonly keys: ReadonlyArray<Record<string, unknown> & { readonly kid?: string }>
}

/**
 * Google's signing keys, fetched and remembered.
 *
 * Cached because Google rotates keys on the order of days and a sign-in is not the moment to
 * fetch a key set. **Refetched once on a miss**, which is what makes rotation survivable: a
 * token arrives signed with a key added since the cache was filled, the cache is refreshed, and
 * the sign-in succeeds. Without that, every rotation would produce a window of failed sign-ins
 * ending whenever the cache happened to expire.
 */
export function jwksCache(uri: string, fetchImpl: typeof fetch = fetch, ttl = 3600) {
  let keys: Map<string, KeyObject> = new Map()
  let fetchedAt = 0

  const load = async (now: number): Promise<void> => {
    const response = await fetchImpl(uri, { headers: { accept: 'application/json' } })
    if (!response.ok) {
      throw new SignInError(
        'identity',
        `Could not read the provider’s signing keys (${response.status}).`,
      )
    }
    const jwks = (await response.json()) as Jwks

    const next = new Map<string, KeyObject>()
    for (const jwk of jwks.keys ?? []) {
      if (typeof jwk.kid !== 'string') continue
      try {
        // The line that usually motivates `jose`. It does not need to.
        next.set(jwk.kid, createPublicKey({ key: jwk as never, format: 'jwk' }))
      } catch {
        // A key this Node build cannot import — an unusual curve, a future algorithm. Skipping
        // it is right: the others still work, and refusing the whole set would turn one
        // unfamiliar key into a total sign-in outage.
      }
    }
    keys = next
    fetchedAt = now
  }

  return {
    async get(kid: string, now = Date.now()): Promise<KeyObject | undefined> {
      if (keys.size === 0 || now - fetchedAt > ttl * 1000) await load(now)
      const found = keys.get(kid)
      if (found !== undefined) return found

      // A miss on a fresh cache means a key added since. See the note above.
      await load(now)
      return keys.get(kid)
    },
    /** For tests, and for a future admin endpoint that forces a refresh. */
    forget(): void {
      keys = new Map()
      fetchedAt = 0
    },
  }
}

const decode = (part: string): unknown => JSON.parse(Buffer.from(part, 'base64url').toString())

/**
 * Verifies a Google ID token and returns the identity in it.
 *
 * Checks, in this order and for these reasons:
 *
 * 1. **`alg` is RS256.** Before anything else, for the same reason as in `jwt.ts`: accepting the
 *    algorithm a token names is the classic JWT vulnerability.
 * 2. **The signature**, against the key the token's `kid` names.
 * 3. **`iss`**, because a validly-signed token from another issuer is still not Google's.
 * 4. **`aud`**, because a validly-signed Google token issued to *another application* is a real
 *    thing that exists — this is the confused-deputy check, and omitting it lets anyone with a
 *    Google client id sign their users into this one.
 * 5. **`exp`**.
 */
export async function verifyGoogleIdToken(
  provider: Provider,
  idToken: string,
  keys: ReturnType<typeof jwksCache>,
  now: () => number = () => Math.floor(Date.now() / 1000),
): Promise<Identity> {
  const parts = idToken.split('.')
  if (parts.length !== 3) throw new SignInError('identity', 'The ID token is malformed.')
  const [header, payload, signature] = parts as [string, string, string]

  let head: { alg?: unknown; kid?: unknown }
  let claims: Record<string, unknown>
  try {
    head = decode(header) as { alg?: unknown; kid?: unknown }
    claims = decode(payload) as Record<string, unknown>
  } catch {
    throw new SignInError('identity', 'The ID token is not readable.')
  }

  if (head.alg !== 'RS256') {
    throw new SignInError(
      'identity',
      `Google ID tokens are RS256; this claims ${String(head.alg)}.`,
    )
  }
  if (typeof head.kid !== 'string') {
    throw new SignInError('identity', 'The ID token names no signing key.')
  }

  const key = await keys.get(head.kid)
  if (key === undefined) {
    throw new SignInError('identity', 'The ID token was signed with a key Google does not publish.')
  }

  const verifier = createVerify('RSA-SHA256')
  verifier.update(`${header}.${payload}`)
  let ok = false
  try {
    ok = verifier.verify(key, Buffer.from(signature, 'base64url'))
  } catch {
    ok = false
  }
  if (!ok) throw new SignInError('identity', 'The ID token’s signature does not match.')

  if (typeof claims.iss !== 'string' || !GOOGLE_ENDPOINTS.issuers.includes(claims.iss as never)) {
    throw new SignInError('identity', 'The ID token was not issued by Google.')
  }

  // The confused-deputy check. A validly-signed Google token issued to a *different* application
  // is an ordinary thing that exists in the world; without this, anybody holding a Google client
  // id could sign their users into this one.
  const audience = Array.isArray(claims.aud) ? claims.aud : [claims.aud]
  if (!audience.includes(provider.clientId)) {
    throw new SignInError('identity', 'The ID token was issued to a different application.')
  }

  if (typeof claims.exp !== 'number' || claims.exp <= now()) {
    throw new SignInError('identity', 'The ID token has expired.')
  }

  return identityFrom(provider, claims)
}
