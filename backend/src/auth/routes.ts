/**
 * The three sign-in operations the contract declares.
 *
 * **Tokens never touch `localStorage`**, and the four credentials here each live where their
 * use allows:
 *
 * - the sign-in flow's PKCE carrier is an **httpOnly** cookie the page cannot read;
 * - the callback sets an **httpOnly** handoff cookie, two minutes long and single use, whose
 *   only power is to authorise the first `POST /auth/token`;
 * - that call returns the CouchDB access token and the refresh token **in a response body**.
 *   The access token is held in memory and re-requested when it expires; the refresh token is
 *   kept in `mm-local` (IndexedDB) by explicit decision, so a reload or a new tab can refresh
 *   without a redirect. The cost of a script-readable refresh token is set out in the spec's
 *   "trade-off of a body token" (`docs/superpowers/specs/2026-10-03-projects-landing-and-user-record-design.md`).
 *
 * The access token has to be *readable* by the page — PouchDB puts it in an `Authorization`
 * header — so it cannot be httpOnly. Five minutes and in memory is the trade this makes, and it
 * is also what bounds how stale a plan in `_couchdb.roles` can be.
 *
 * @module
 */

import { randomUUID } from 'node:crypto'
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import { problem } from '../problem.js'
import { planOf, type UserRecords } from '../users/records.js'
import { bearerToken } from './bearer.js'
import type { DenyList } from './deny-list.js'
import { type Claims, mintToken, type SigningKey, verifyToken } from './jwt.js'
import type { Identity, Provider } from './oidc.js'
import { beginSignIn, completeSignIn, readFlowState, SignInError } from './oidc.js'
import { hashJti, type RefreshStore } from './refresh-store.js'
import { consoleSignInLog, type SignInLogger } from './sign-in-log.js'

/** The cookie carrying the PKCE verifier and state across the redirect. */
const FLOW_COOKIE = 'mm_flow'
/** Bridges the redirect to the first `POST /auth/token`. Two minutes, single use. */
const HANDOFF_COOKIE = 'mm_handoff'

/**
 * How long a CouchDB access token lives, in seconds.
 *
 * Five minutes, because CouchDB verifies the token itself and never asks this service: sign-out
 * cannot reach a copy already taken, and a plan an operator changes reaches CouchDB only at the
 * next mint. This number is the bound on both.
 */
export const ACCESS_TOKEN_TTL = 300
/** How long a refresh token lives, in seconds. Revocation, not expiry, is what ends one early. */
export const REFRESH_TOKEN_TTL = 30 * 24 * 3600
/** How long the handoff cookie lives, in seconds. Long enough for a redirect, and no longer. */
export const HANDOFF_TTL = 120

/** An identity whose address the provider vouched for. Records are keyed by it. */
export type VerifiedIdentity = Identity & { readonly email: string; readonly emailVerified: true }

const isVerified = (identity: Identity): identity is VerifiedIdentity =>
  identity.email !== undefined && identity.email !== '' && identity.emailVerified === true

/** What the routes need that this module does not own. */
export interface AuthDependencies {
  readonly provider: Provider
  /**
   * The key CouchDB validates.
   *
   * Its public half is installed in CouchDB's `[jwt_keys]` by `keys.ts`, so **anything signed
   * with it is a database credential**. Only the access token is, and only for five minutes.
   */
  readonly key: SigningKey
  /**
   * The key for credentials CouchDB must never accept: the refresh token, the handoff cookie
   * and the PKCE carrier.
   *
   * A separate key rather than a `purpose` claim, because **CouchDB does not evaluate claims it
   * was not taught about** — it checks a signature and an expiry, and nothing else. So a
   * thirty-day refresh token signed with the key above would be a thirty-day database credential
   * however carefully this service refused to accept one. A claim cannot fix that; a key CouchDB
   * has never been given can, because CouchDB cannot verify the signature at all.
   *
   * Its public half is never installed anywhere.
   */
  readonly sessionKey: SigningKey
  /** Verifies a provider ID token. Injected so the routes test without a JWKS endpoint. */
  readonly verifyIdToken: (idToken: string) => Promise<Identity>
  /** Where the browser is sent after a successful sign-in. */
  readonly appOrigin: string
  /** User records: read on every mint, for the plan the access token carries. */
  readonly records: UserRecords
  /** Where refresh-token hashes are kept, and therefore where revoking one happens. */
  readonly refresh: RefreshStore
  /** Access tokens signed out before their expiry, and handoffs already exchanged. */
  readonly deny: DenyList
  /** Accepts pending invitations, creating the record only when one is redeemable. */
  readonly signIn: (identity: VerifiedIdentity) => Promise<{ readonly hasRecord: boolean }>
  /** Where each completed sign-in is recorded. Defaults to one JSON line on stdout. */
  readonly logSignIn?: SignInLogger
  /**
   * How the provider's token endpoint is reached.
   *
   * Injected so a test can complete a whole sign-in without a network. Without this seam the
   * only way to exercise the callback is to let it call Google — which is a test that needs
   * credentials, an internet connection and a real user, and therefore a test nobody runs.
   */
  readonly fetchImpl?: typeof fetch
  readonly now?: () => number
}

/**
 * Cookie attributes.
 *
 * `SameSite=Lax` rather than `Strict` for the flow cookie, and this is load-bearing: the
 * callback arrives as a **cross-site navigation from Google**, and `Strict` withholds cookies
 * on exactly that. The result would be a sign-in that fails only in production, only after a
 * real redirect, with a state error that looks like a bug in the state check.
 *
 * `Secure` unless plainly local, so a developer on `http://localhost` is not locked out by a
 * cookie the browser silently refuses to store.
 */
function cookieAttributes(maxAge: number, secure: boolean): string {
  return ['Path=/', 'HttpOnly', 'SameSite=Lax', secure ? 'Secure' : '', `Max-Age=${maxAge}`]
    .filter((part) => part !== '')
    .join('; ')
}

/** Reads one cookie out of a request. Fastify parses none by default and none is needed. */
function cookie(request: FastifyRequest, name: string): string | undefined {
  const header = request.headers.cookie
  if (header === undefined) return undefined
  for (const part of header.split(';')) {
    const [key, ...rest] = part.trim().split('=')
    if (key === name) return decodeURIComponent(rest.join('='))
  }
  return undefined
}

/** Sets a cookie without replacing any already set on the reply. */
function setCookie(reply: FastifyReply, value: string): void {
  const existing = reply.getHeader('set-cookie')
  const all = Array.isArray(existing) ? existing : existing === undefined ? [] : [String(existing)]
  reply.header('set-cookie', [...all, value])
}

/**
 * Registers Google sign-in, callback, sign-out, and token routes.
 *
 * @param app - The Fastify application to which the routes are added
 * @param deps - Authentication providers, keys, stores, and runtime dependencies
 */
export function registerAuthRoutes(app: FastifyInstance, deps: AuthDependencies): void {
  const secure = !deps.appOrigin.startsWith('http://localhost')
  const now = deps.now ?? (() => Math.floor(Date.now() / 1000))
  const logSignIn = deps.logSignIn ?? consoleSignInLog()

  app.get('/auth/google', async (request, reply) => {
    const returnTo = (request.query as { returnTo?: string }).returnTo ?? '/'
    const { authorizeUrl, carrier } = beginSignIn(deps.provider, deps.sessionKey, returnTo, now)

    setCookie(
      reply,
      `${FLOW_COOKIE}=${encodeURIComponent(carrier)}; ${cookieAttributes(600, secure)}`,
    )
    return reply.redirect(authorizeUrl, 302)
  })

  app.get('/auth/google/callback', async (request, reply) => {
    const query = request.query as { code?: string; state?: string; error?: string }

    // The user pressed Cancel at the consent screen. Not an error to report — they made a
    // choice — so they are returned to the application signed out, with **no partial account
    // created**. Nothing has been written by this point.
    if (query.error !== undefined || query.code === undefined) {
      clearCookies(reply, secure)
      return reply.redirect(`${deps.appOrigin}/`, 302)
    }

    let identity: VerifiedIdentity
    let returnTo = '/'
    try {
      const flow = readFlowState(cookie(request, FLOW_COOKIE), query.state, deps.sessionKey, now)
      returnTo = flow.returnTo
      const claimed = await completeSignIn(
        deps.provider,
        query.code,
        flow,
        deps.verifyIdToken,
        deps.fetchImpl,
      )
      // Records, invitations and refresh hashes are all keyed by the address, so an address the
      // provider did not vouch for would let somebody sign in as whoever they typed.
      if (!isVerified(claimed)) {
        throw new SignInError('unverified', 'The provider did not verify this address.')
      }
      identity = claimed
      // After the identity is verified and before the handoff is issued. A failure here means
      // no handoff, which is the right way round: a failed sign-in can simply be repeated.
      const { hasRecord } = await deps.signIn(identity)
      logSignIn({
        sub: identity.sub,
        email: identity.email,
        provider: deps.provider.name,
        hasRecord,
      })
    } catch (error) {
      // Not logged with the query: it contains an authorization code. `SignInError` carries a
      // short problem code, and anything else is a fault rather than a rejected sign-in.
      request.log.warn(
        { problem: error instanceof SignInError ? error.problem : 'unknown' },
        'sign-in did not complete',
      )
      clearCookies(reply, secure)
      return reply.redirect(`${deps.appOrigin}/?signin=failed`, 302)
    }

    // The handoff, as an httpOnly cookie the page cannot read. Its only use is to authorise the
    // first `POST /auth/token`, which is what hands the page something it *can* read. It carries
    // the address and name so that call needs no lookup to mint a refresh token.
    const handoff = mintToken(deps.sessionKey, {
      purpose: 'handoff',
      sub: identity.sub,
      email: identity.email,
      ...(identity.name === undefined ? {} : { name: identity.name }),
      jti: randomUUID(),
      exp: now() + HANDOFF_TTL,
    })
    setCookie(reply, `${FLOW_COOKIE}=; ${cookieAttributes(0, secure)}`)
    setCookie(
      reply,
      `${HANDOFF_COOKIE}=${encodeURIComponent(handoff)}; ${cookieAttributes(HANDOFF_TTL, secure)}`,
    )
    return reply.redirect(`${deps.appOrigin}${returnTo}`, 302)
  })

  app.post('/auth/token', async (request, reply) => {
    const body = request.body as { refreshToken?: unknown } | null | undefined
    // `{ title, status }` as `application/problem+json`, as the contract declares. Every refusal
    // below is byte-for-byte this one: a credential that is absent, expired, forged, spent or
    // revoked is the same fact to the caller — "sign in again" — and telling them apart would
    // say whether a token this service issued is still good to somebody holding a stolen one.
    const unauthorized = () => problem(reply, { title: 'Not signed in', status: 401 })

    let claims: Claims & { readonly email: string }
    let refreshToken: string
    if (typeof body?.refreshToken === 'string' && body.refreshToken !== '') {
      let presented: Claims
      try {
        presented = verifyToken(body.refreshToken, deps.sessionKey.publicKey, 'refresh', now)
      } catch {
        return unauthorized()
      }
      if (presented.email === undefined || presented.jti === undefined) return unauthorized()
      // A signature alone is not enough: revocation is deletion of the stored hash, so a token
      // is honoured only while its hash is still found (see `refresh-store.ts`).
      if (!(await deps.refresh.isLive(presented.email, hashJti(presented.jti)))) {
        return unauthorized()
      }
      claims = { ...presented, email: presented.email }
      // Returned unchanged. Rotation is tracked as an issue, not done here.
      refreshToken = body.refreshToken
    } else {
      const handoff = cookie(request, HANDOFF_COOKIE)
      if (handoff === undefined) return unauthorized()
      let bridged: Claims
      try {
        bridged = verifyToken(handoff, deps.sessionKey.publicKey, 'handoff', now)
      } catch {
        return unauthorized()
      }
      if (bridged.email === undefined || bridged.jti === undefined) return unauthorized()
      // Single use. The deny list already forgets entries at their expiry, which is exactly the
      // lifetime a used handoff has to be remembered for.
      if (deps.deny.denied(bridged.jti)) return unauthorized()
      deps.deny.deny(bridged.jti, bridged.exp)

      const jti = randomUUID()
      const exp = now() + REFRESH_TOKEN_TTL
      claims = {
        purpose: 'refresh',
        sub: bridged.sub,
        email: bridged.email,
        ...(bridged.name === undefined ? {} : { name: bridged.name }),
        jti,
        iat: now(),
        exp,
      }
      refreshToken = mintToken(deps.sessionKey, claims)
      // Only the hash is stored, so a leaked record or memory dump is not a set of credentials.
      await deps.refresh.remember(bridged.email, { hash: hashJti(jti), exp, createdAt: now() })
      setCookie(reply, `${HANDOFF_COOKIE}=; ${cookieAttributes(0, secure)}`)
    }

    // Read on every mint, so an operator's change reaches CouchDB within one token lifetime.
    const plan = planOf(await deps.records.read(claims.email))
    const accessToken = mintToken(deps.key, {
      // Not interchangeable with the refresh token above, deliberately. See `TokenPurpose`.
      purpose: 'access',
      sub: claims.sub,
      email: claims.email,
      // The deny list's key, so sign-out can refuse this token on this API before its expiry.
      jti: randomUUID(),
      iat: now(),
      exp: now() + ACCESS_TOKEN_TTL,
      '_couchdb.roles': [plan],
    })

    // Never cached. A token in a shared cache is a token for whoever asks next.
    reply.header('cache-control', 'no-store')
    return { accessToken, expiresIn: ACCESS_TOKEN_TTL, refreshToken }
  })

  app.post('/auth/signout', async (request, reply) => {
    // No credential is required. Signing out when signed out is not an error, and answering 401
    // would leave a user who is confused about their state unable to reach one they are certain
    // about. Each credential presented is ended as far as this service can end it.
    const body = request.body as { refreshToken?: unknown } | null | undefined
    if (typeof body?.refreshToken === 'string') {
      try {
        const claims = verifyToken(body.refreshToken, deps.sessionKey.publicKey, 'refresh', now)
        if (claims.email !== undefined && claims.jti !== undefined) {
          await deps.refresh.revoke(claims.email, hashJti(claims.jti))
        }
      } catch {
        // A token that does not verify has nothing to revoke.
      }
    }
    const access = bearerToken(request.headers.authorization)
    if (access !== undefined) {
      try {
        const claims = verifyToken(access, deps.key.publicKey, 'access', now)
        // This API only: CouchDB never asks, so a copy already taken replicates until `exp`.
        if (claims.jti !== undefined) deps.deny.deny(claims.jti, claims.exp)
      } catch {
        // Expired or forged: nothing to deny.
      }
    }
    clearCookies(reply, secure)
    return reply.code(204).send()
  })
}

/**
 * Clears the sign-in flow and handoff cookies.
 *
 * @param reply - The response to which expired cookie headers are appended
 * @param secure - Whether the cookies require the `Secure` attribute
 */
function clearCookies(reply: FastifyReply, secure: boolean): void {
  setCookie(reply, `${FLOW_COOKIE}=; ${cookieAttributes(0, secure)}`)
  setCookie(reply, `${HANDOFF_COOKIE}=; ${cookieAttributes(0, secure)}`)
}
