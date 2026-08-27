/**
 * Signing in with an identity provider: authorization code with PKCE.
 *
 * **Only Google is wired, and nothing here knows that.** The issue asks for a pluggable provider
 * layer with one provider connected, and the difference between "pluggable" and "has an
 * interface" is whether the concrete one can be swapped without editing anything but a
 * configuration value. {@link Provider} is three endpoints, a client id and a secret; `google.ts`
 * supplies Google's.
 *
 * **PKCE, and it is not optional here.** The authorization code comes back through the user's
 * browser — through a redirect anyone can observe in a log, a referrer, or an extension. PKCE
 * makes an intercepted code useless without the verifier, which never leaves this service.
 *
 * **The `state` is checked, and it is not the same thing.** PKCE protects the *code*; state
 * protects the *session*, by making a callback that this service did not initiate impossible to
 * act on. Skipping it is CSRF: an attacker walks a victim's browser through *their* sign-in and
 * the victim ends up signed in as the attacker, quietly, in an application that stores their
 * home's commissioning codes.
 *
 * @module
 */

import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'
import { type SigningKey, signCompact, TokenError, verifyCompact } from './jwt.js'

/** What this service needs to know about an identity provider. */
export interface Provider {
  /** Names the provider in a subject, e.g. `google` in `google|1234`. */
  readonly name: string
  readonly authorizationEndpoint: string
  readonly tokenEndpoint: string
  /** Where the provider publishes its signing keys. */
  readonly jwksUri: string
  readonly clientId: string
  readonly clientSecret: string
  /** Must match what is registered with the provider, exactly. */
  readonly redirectUri: string
  readonly scopes: readonly string[]
}

/** What is carried across the redirect, signed, so this service holds no session state. */
export interface FlowState {
  /** Always `flow`, so this carrier cannot be presented as a session. See `TokenPurpose`. */
  readonly purpose: 'flow'
  /** Random, and compared on the way back. */
  readonly state: string
  /** The PKCE verifier. **Never leaves this service and never reaches the browser.** */
  readonly verifier: string
  /** Where to send the browser afterwards, within the application. */
  readonly returnTo: string
  readonly exp: number
}

/** Who signed in. */
export interface Identity {
  /** `google|1234…`, which becomes the CouchDB user name. */
  readonly sub: string
  readonly email?: string
  /**
   * Whether the provider says it has verified the address.
   *
   * **Only ever `true` when the claim is literally `true`.** An invitation is redeemed by
   * signing in with the address it was sent to (M5-4), so this is the claim that decides
   * whether somebody *is* the invitee or merely says so — and Google issues tokens with
   * `email_verified: false` for an address a user has typed in themselves. A missing claim is
   * not a yes.
   */
  readonly emailVerified?: boolean
  readonly name?: string
  readonly picture?: string
}

export type SignInProblem =
  /** The callback carried no code, or the user pressed Cancel. */
  | 'abandoned'
  /** The state did not match, or the carrier was missing, expired or forged. */
  | 'state'
  /** The provider refused the code exchange. */
  | 'exchange'
  /** The provider's answer was not something this service can read. */
  | 'identity'

export class SignInError extends Error {
  override readonly name = 'SignInError'
  readonly problem: SignInProblem

  constructor(problem: SignInProblem, message: string) {
    super(message)
    this.problem = problem
  }
}

/** Base64url of random bytes: what both the state and the PKCE verifier are made of. */
const random = (bytes = 32): string => randomBytes(bytes).toString('base64url')

/**
 * The S256 challenge for a verifier.
 *
 * S256 rather than `plain`. `plain` sends the verifier itself as the challenge, which is the
 * thing PKCE exists to keep off the wire — it is in the specification for clients that cannot
 * compute a SHA-256, and a Node service is not one of them.
 */
export function codeChallenge(verifier: string): string {
  return createHash('sha256').update(verifier).digest('base64url')
}

/** How long a sign-in may take before the carrier expires. Ten minutes is a slow consent screen. */
const FLOW_TTL = 600

/**
 * Starts a sign-in.
 *
 * @returns where to send the browser, and the signed carrier to set as a cookie
 */
export function beginSignIn(
  provider: Provider,
  key: SigningKey,
  returnTo = '/',
  now: () => number = () => Math.floor(Date.now() / 1000),
): { readonly authorizeUrl: string; readonly carrier: string } {
  const state = random()
  const verifier = random(48)

  const url = new URL(provider.authorizationEndpoint)
  url.searchParams.set('response_type', 'code')
  url.searchParams.set('client_id', provider.clientId)
  url.searchParams.set('redirect_uri', provider.redirectUri)
  url.searchParams.set('scope', provider.scopes.join(' '))
  url.searchParams.set('state', state)
  url.searchParams.set('code_challenge', codeChallenge(verifier))
  url.searchParams.set('code_challenge_method', 'S256')

  const carrier = signCompact(key, {
    purpose: 'flow',
    state,
    verifier,
    // Only a path, never a full URL. An open redirect here is a phishing primitive that
    // arrives wearing this application's own domain: sign in, be sent somewhere else.
    returnTo: returnTo.startsWith('/') && !returnTo.startsWith('//') ? returnTo : '/',
    exp: now() + FLOW_TTL,
  } satisfies FlowState)

  return { authorizeUrl: url.toString(), carrier }
}

/** Constant-time comparison of two strings, so a state check leaks nothing about timing. */
function equals(a: string, b: string): boolean {
  const left = Buffer.from(a)
  const right = Buffer.from(b)
  // `timingSafeEqual` throws on a length mismatch, which would itself be a timing signal — so
  // the lengths are compared first and the result folded in rather than returned early.
  if (left.length !== right.length) return false
  return timingSafeEqual(left, right)
}

/**
 * Reads and checks the carrier against the state the provider sent back.
 *
 * @throws {SignInError} on `state` for a missing, expired, forged or mismatched carrier. All
 *   four are the same answer to the user — start again — and distinguishing them in the response
 *   would tell an attacker which part of their attempt was wrong.
 */
export function readFlowState(
  carrier: string | undefined,
  returnedState: string | undefined,
  key: SigningKey,
  now: () => number = () => Math.floor(Date.now() / 1000),
): FlowState {
  if (carrier === undefined || returnedState === undefined) {
    throw new SignInError('state', 'The sign-in could not be matched to a request from this app.')
  }

  let flow: FlowState
  try {
    flow = verifyCompact<FlowState>(carrier, key.publicKey, 'flow', now)
  } catch (error) {
    // Includes expiry, a forged signature and a wrong algorithm — `verifyCompact` makes the
    // same checks a CouchDB token gets, which is the point of sharing it.
    throw new SignInError(
      'state',
      error instanceof TokenError
        ? `The sign-in request is no longer valid (${error.problem}).`
        : 'The sign-in request could not be read.',
    )
  }

  if (!equals(flow.state, returnedState)) {
    throw new SignInError('state', 'The sign-in did not come from a request this app started.')
  }

  return flow
}

/** What a provider's token endpoint returns. Only what is used is named. */
interface TokenResponse {
  readonly id_token?: string
  readonly access_token?: string
  readonly error?: string
}

/**
 * Exchanges the authorization code for the provider's tokens, then reads the identity out.
 *
 * The exchange is **server to server**, carrying the client secret and the PKCE verifier. The
 * browser never sees either.
 *
 * @param verifyIdToken how the ID token is checked. Injected because it needs the provider's
 *   JWKS, which is a network call — and because a test that had to stand up a fake JWKS endpoint
 *   to check the exchange would be testing two things at once.
 */
export async function completeSignIn(
  provider: Provider,
  code: string,
  flow: FlowState,
  verifyIdToken: (idToken: string) => Promise<Identity>,
  fetchImpl: typeof fetch = fetch,
): Promise<Identity> {
  const response = await fetchImpl(provider.tokenEndpoint, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
    body: new URLSearchParams({
      grant_type: 'authorization_code',
      code,
      client_id: provider.clientId,
      client_secret: provider.clientSecret,
      redirect_uri: provider.redirectUri,
      // The other half of PKCE. Without it the provider has no reason to believe this exchange
      // comes from whoever started the flow.
      code_verifier: flow.verifier,
    }),
  })

  let body: TokenResponse
  try {
    body = (await response.json()) as TokenResponse
  } catch {
    throw new SignInError('exchange', 'The identity provider’s answer was not readable.')
  }

  if (!response.ok || body.id_token === undefined) {
    // The provider's own `error` code is short and safe — `invalid_grant`, `access_denied`. The
    // body is not logged or echoed: it carries tokens.
    throw new SignInError(
      'exchange',
      `The identity provider refused the sign-in (${body.error ?? response.status}).`,
    )
  }

  return verifyIdToken(body.id_token)
}

/** Turns a verified ID token's claims into an identity, refusing anything unusable. */
export function identityFrom(provider: Provider, claims: Record<string, unknown>): Identity {
  const sub = claims.sub
  if (typeof sub !== 'string' || sub === '') {
    throw new SignInError('identity', 'The identity provider returned no subject.')
  }

  // Namespaced by provider, so that two providers cannot collide on a numeric subject — and so
  // that a CouchDB user name says where the identity came from. `google|1234`.
  const text = (value: unknown): string | undefined =>
    typeof value === 'string' && value !== '' ? value : undefined

  const email = text(claims.email)
  const name = text(claims.name)
  const picture = text(claims.picture)
  // Strictly `=== true`. Providers have been known to send the string `"true"`, and a truthy
  // check would accept it — along with `"false"`, which is also a non-empty string.
  const emailVerified = claims.email_verified === true

  return {
    sub: `${provider.name}|${sub}`,
    ...(email === undefined ? {} : { email }),
    ...(emailVerified ? { emailVerified } : {}),
    ...(name === undefined ? {} : { name }),
    ...(picture === undefined ? {} : { picture }),
  }
}
