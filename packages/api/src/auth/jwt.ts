/**
 * Minting and reading the ES256 tokens CouchDB validates for itself.
 *
 * The shape here is not invented: `infra/couchdb/verify-jwt-model.sh` establishes it against a
 * real CouchDB 3.5.2 in CI, including that expired tokens, tokens signed with another key, and
 * tokens whose payload was edited to claim a different `sub` are all genuinely refused. This
 * module produces exactly what that script proved CouchDB accepts.
 *
 * **ES256 rather than RS256.** Smaller signatures on every replication request for equivalent
 * security, and replication makes a great many requests.
 *
 * **`node:crypto` rather than `jose` or `jsonwebtoken`** (ADR 0013). Two lines usually motivate
 * reaching for a library and neither needs to:
 *
 * ```js
 * sign.sign({ key, dsaEncoding: 'ieee-p1363' })   // JOSE wants raw R‖S; Node emits DER
 * createPublicKey({ key: jwk, format: 'jwk' })    // Google's JWKS, imported directly
 * ```
 *
 * The first is the one that silently produces a token nothing will verify: without
 * `dsaEncoding`, Node signs correctly and encodes the signature as DER, which is the same
 * algorithm and different bytes. CouchDB rejects it with no hint as to why.
 *
 * @module
 */

import {
  createPrivateKey,
  createPublicKey,
  createSign,
  createVerify,
  type KeyObject,
} from 'node:crypto'

/** Base64url, which JOSE uses everywhere and Node spells as an encoding. */
const encode = (value: string | object): string =>
  Buffer.from(typeof value === 'string' ? value : JSON.stringify(value)).toString('base64url')

const decode = (value: string): unknown => JSON.parse(Buffer.from(value, 'base64url').toString())

/** What CouchDB is told about the bearer. */
/**
 * What a token is for.
 *
 * Every token this service signs carries one, and every verification states which it expects.
 * Without it the three credentials are the same bytes with different lifetimes and are
 * therefore **mutually substitutable**, which costs in both directions:
 *
 * - the access token is handed to page scripts on purpose (PouchDB needs it in a header), so a
 *   script that exfiltrates one could present it as a session and mint fresh access tokens for
 *   as long as it liked — making the one-hour lifetime a limit on nothing;
 * - the session lasts thirty days and **CouchDB validates these tokens itself**, checking a
 *   signature and an expiry and nothing else, so a session presented as a bearer is a
 *   thirty-day direct database credential.
 *
 * A claim is the cheapest way to say which is which, and checking it is one comparison.
 */
export type TokenPurpose = 'access' | 'session' | 'flow'

export interface Claims {
  /** What this token may be presented as. See {@link TokenPurpose}. */
  readonly purpose: TokenPurpose
  /** The identity provider's subject. CouchDB maps this to a user name. */
  readonly sub: string
  /** Seconds since the epoch. */
  readonly exp: number
  /** Seconds since the epoch; when the token becomes valid. */
  readonly iat?: number
  /**
   * CouchDB roles, under the name CouchDB reads them from.
   *
   * The odd-looking key is CouchDB's, not ours: it namespaces its own claims so they cannot
   * collide with a provider's. A token carrying `roles` instead is a token whose roles CouchDB
   * silently ignores — the request succeeds as a user with no roles, which looks like a
   * permissions bug rather than a claim-name bug.
   */
  readonly '_couchdb.roles'?: readonly string[]
}

/** A signing key and the `kid` it is published under. */
export interface SigningKey {
  /** Names the key in the token header and in CouchDB's `[jwt_keys]`. */
  readonly kid: string
  readonly privateKey: KeyObject
  readonly publicKey: KeyObject
}

/**
 * Loads a signing key from PEM.
 *
 * @param kid what to call it. Key material never enters the image, so this is how a running
 *   service and CouchDB agree about which key a token was signed with — and it is what makes
 *   rotation possible: old and new coexist under different names.
 */
export function signingKeyFromPem(kid: string, privatePem: string): SigningKey {
  const privateKey = createPrivateKey(privatePem)
  if (privateKey.asymmetricKeyType !== 'ec') {
    throw new TypeError(
      `The signing key must be an EC key for ES256; this one is ${privateKey.asymmetricKeyType ?? 'unrecognised'}.`,
    )
  }
  return { kid, privateKey, publicKey: createPublicKey(privateKey) }
}

/**
 * Signs a token.
 *
 * The `kid` goes in the header because CouchDB uses it to pick a key from `[jwt_keys]`. Without
 * one, CouchDB falls back to the key named `_default` — which works right up until a second key
 * exists, and then rotation stops working in a way that only shows up under load.
 */
export function mintToken(key: SigningKey, claims: Claims): string {
  return signCompact(key, claims)
}

/**
 * Signs any claims as a compact ES256 JWT.
 *
 * Exported because the sign-in flow needs a signed, short-lived carrier for its PKCE verifier
 * and state, and that carrier is a JWT with different claims rather than a different mechanism.
 * One implementation of the ES256 detail below, used by both — two would be two chances to get
 * `dsaEncoding` wrong, in the same service, months apart.
 */
export function signCompact(key: SigningKey, claims: object): string {
  const header = encode({ alg: 'ES256', typ: 'JWT', kid: key.kid })
  const payload = encode(claims)

  const signer = createSign('SHA256')
  signer.update(`${header}.${payload}`)
  // The line that matters. JOSE requires the raw R‖S pair; Node emits DER unless told
  // otherwise, and a DER signature is the same algorithm with different bytes — accepted by
  // nothing, explained by nobody.
  const signature = signer.sign({ key: key.privateKey, dsaEncoding: 'ieee-p1363' })

  return `${header}.${payload}.${signature.toString('base64url')}`
}

/** Why a token was not accepted. A code rather than a sentence: some of these are not for users. */
export type TokenProblem =
  | 'malformed'
  | 'algorithm'
  | 'signature'
  | 'expired'
  | 'not-yet-valid'
  /** The token is genuine and is for something else. See {@link TokenPurpose}. */
  | 'purpose'

export class TokenError extends Error {
  override readonly name = 'TokenError'
  readonly problem: TokenProblem

  constructor(problem: TokenProblem, message: string) {
    super(message)
    this.problem = problem
  }
}

/** The `kid` a token claims, without verifying anything. For choosing which key to check against. */
export function kidOf(token: string): string | undefined {
  const header = token.split('.')[0]
  if (header === undefined) return undefined
  try {
    const parsed = decode(header) as { kid?: unknown }
    return typeof parsed.kid === 'string' ? parsed.kid : undefined
  } catch {
    return undefined
  }
}

/**
 * Verifies a token and returns its claims.
 *
 * This service does not strictly need to verify its own tokens — CouchDB does that — but the
 * startup check in `keys.ts` does, and so does anything that reads a bearer on an API request.
 * More to the point: a minting function with no verifier is a minting function whose output
 * nobody has read back, and the failure mode of ES256 signature encoding is precisely that the
 * bytes look fine.
 *
 * @param now injected so expiry is testable without waiting an hour
 * @throws {TokenError} naming the problem
 */
export function verifyToken(
  token: string,
  publicKey: KeyObject,
  expected: TokenPurpose,
  now: () => number = () => Math.floor(Date.now() / 1000),
): Claims {
  const claims = verifyCompact<Claims>(token, publicKey, expected, now)
  // Every caller of this function immediately reads `.sub` and treats it as an identity. A
  // token whose `sub` is missing or empty would become an empty user name, which CouchDB is
  // perfectly willing to hold documents for.
  if (typeof claims.sub !== 'string' || claims.sub === '') {
    throw new TokenError('purpose', 'The token identifies nobody.')
  }
  return claims
}

/**
 * Verifies any compact ES256 JWT and returns its claims.
 *
 * The generic half of {@link verifyToken}, so that the sign-in flow's carrier gets the same
 * algorithm-confusion guard, the same wrapped `verify`, and the same expiry rule as a CouchDB
 * token. A separate implementation for it would be a second place to forget one of them.
 */
export function verifyCompact<T extends { exp: number; iat?: number; purpose: TokenPurpose }>(
  token: string,
  publicKey: KeyObject,
  expected: TokenPurpose,
  now: () => number = () => Math.floor(Date.now() / 1000),
): T {
  const parts = token.split('.')
  if (parts.length !== 3) throw new TokenError('malformed', 'A JWT has three parts.')
  const [header, payload, signature] = parts as [string, string, string]

  let head: { alg?: unknown }
  let claims: T
  try {
    head = decode(header) as { alg?: unknown }
    claims = decode(payload) as T
  } catch {
    throw new TokenError('malformed', 'The token’s header or payload is not JSON.')
  }

  // Checked before the signature, and this is not an ordering preference. Accepting whatever
  // algorithm a token names is the classic JWT vulnerability: a token claiming `none`, or an
  // HMAC token verified against the public key as though it were a shared secret.
  if (head.alg !== 'ES256') {
    throw new TokenError(
      'algorithm',
      `Only ES256 is accepted; this token claims ${String(head.alg)}.`,
    )
  }

  const verifier = createVerify('SHA256')
  verifier.update(`${header}.${payload}`)

  // Wrapped, because `verify` does not merely return false for a signature of the wrong shape —
  // an empty one, or anything that is not 64 bytes, makes it *throw* a native error. Letting
  // that escape would mean a malformed token produces a crypto stack trace where a rejection
  // was meant, and a caller distinguishing "bad token" from "the service is broken" would get
  // it wrong.
  let ok = false
  try {
    ok = verifier.verify(
      { key: publicKey, dsaEncoding: 'ieee-p1363' },
      Buffer.from(signature, 'base64url'),
    )
  } catch {
    ok = false
  }
  if (!ok) throw new TokenError('signature', 'The token’s signature does not match.')

  const at = now()
  if (typeof claims.exp !== 'number' || claims.exp <= at) {
    throw new TokenError('expired', 'The token has expired.')
  }
  // After the signature, because an unsigned token's claims are not worth reading, and before
  // the caller sees them, because the caller is what would use the wrong one.
  if (claims.purpose !== expected) {
    throw new TokenError('purpose', `This token is for ${String(claims.purpose)}, not ${expected}.`)
  }

  if (typeof claims.iat === 'number' && claims.iat > at + 60) {
    // A minute of tolerance, because two machines' clocks differ and a token minted a moment
    // ago by a slightly fast server is not an attack.
    throw new TokenError('not-yet-valid', 'The token is not valid yet.')
  }

  return claims
}

/**
 * The public key as CouchDB wants it in `[jwt_keys]`.
 *
 * PEM, with the header and footer lines and the newlines removed — CouchDB's config is an
 * ini file, where a value cannot span lines. Getting this wrong produces a key CouchDB accepts
 * into its config and then cannot parse, so every token fails to verify while the configuration
 * looks correct.
 */
export function publicKeyForCouch(publicKey: KeyObject): string {
  return publicKey
    .export({ type: 'spki', format: 'pem' })
    .toString()
    .replace(/-----(BEGIN|END) PUBLIC KEY-----/g, '')
    .replace(/\s+/g, '')
}
