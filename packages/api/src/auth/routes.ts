/**
 * The three sign-in operations the contract declares.
 *
 * **Tokens never touch `localStorage`**, which the issue asks for and which shapes all three:
 *
 * - the sign-in flow's PKCE carrier is an **httpOnly** cookie the page cannot read;
 * - the session established by the callback is an **httpOnly** cookie too;
 * - the CouchDB access token is returned by `POST /auth/token` **in a response body**, for the
 *   page to hold in memory and re-request when replication gets a 401.
 *
 * That last one is deliberate rather than inconsistent. The access token has to be *readable* by
 * the page — PouchDB puts it in an `Authorization` header — so it cannot be httpOnly. Keeping it
 * in memory means it dies with the tab; keeping it in `localStorage` means it survives, is
 * readable by any script that ever runs on the origin, and grants direct access to the user's
 * CouchDB database. Short-lived and in memory is the trade this makes.
 *
 * @module
 */

import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import { mintToken, type SigningKey, verifyToken } from './jwt.js'
import type { Identity, Provider } from './oidc.js'
import { beginSignIn, completeSignIn, readFlowState, SignInError } from './oidc.js'

/** The cookie carrying the PKCE verifier and state across the redirect. */
const FLOW_COOKIE = 'mm_flow'
/** The cookie identifying the signed-in user afterwards. */
const SESSION_COOKIE = 'mm_session'

/** How long a CouchDB access token lives. */
export const ACCESS_TOKEN_TTL = 3600

/** What the routes need that this module does not own. */
export interface AuthDependencies {
  readonly provider: Provider
  readonly key: SigningKey
  /** Verifies a provider ID token. Injected so the routes test without a JWKS endpoint. */
  readonly verifyIdToken: (idToken: string) => Promise<Identity>
  /** Where the browser is sent after a successful sign-in. */
  readonly appOrigin: string
  /** Records or updates the user. Returns nothing the routes need; failures propagate. */
  readonly rememberUser: (identity: Identity) => Promise<void>
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
 * Registers Google sign-in, callback, sign-out, and access-token routes.
 *
 * @param app - The Fastify application to which the routes are added
 * @param deps - Authentication providers, keys, callbacks, and runtime dependencies
 */
export function registerAuthRoutes(app: FastifyInstance, deps: AuthDependencies): void {
  const secure = !deps.appOrigin.startsWith('http://localhost')
  const now = deps.now ?? (() => Math.floor(Date.now() / 1000))

  app.get('/auth/google', async (request, reply) => {
    const returnTo = (request.query as { returnTo?: string }).returnTo ?? '/'
    const { authorizeUrl, carrier } = beginSignIn(deps.provider, deps.key, returnTo, now)

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
    // created**, which is the issue's third scenario. Nothing has been written by this point.
    if (query.error !== undefined || query.code === undefined) {
      clearCookies(reply, secure)
      return reply.redirect(`${deps.appOrigin}/`, 302)
    }

    let identity: Identity
    let returnTo = '/'
    try {
      const flow = readFlowState(cookie(request, FLOW_COOKIE), query.state, deps.key, now)
      returnTo = flow.returnTo
      identity = await completeSignIn(
        deps.provider,
        query.code,
        flow,
        deps.verifyIdToken,
        deps.fetchImpl,
      )
      // Written *after* the identity is verified and *before* the session is issued. A failure
      // here means no session, which is the right way round: a signed-in user whose profile
      // does not exist would fail on their next request in a way nothing explains.
      await deps.rememberUser(identity)
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

    // The session, as an httpOnly cookie the page cannot read. Its only use is to authorise
    // `POST /auth/token`, which is what hands the page something it *can* read.
    const session = mintToken(deps.key, {
      purpose: 'session',
      sub: identity.sub,
      exp: now() + 30 * 24 * 3600,
    })
    setCookie(reply, `${FLOW_COOKIE}=; ${cookieAttributes(0, secure)}`)
    setCookie(
      reply,
      `${SESSION_COOKIE}=${encodeURIComponent(session)}; ${cookieAttributes(30 * 24 * 3600, secure)}`,
    )

    return reply.redirect(`${deps.appOrigin}${returnTo}`, 302)
  })

  app.post('/auth/signout', async (_request, reply) => {
    // Necessary as a *server* operation because the session cookie is httpOnly: the page cannot
    // remove it, and a page that merely forgot its own token would still be signed in on the
    // next request.
    //
    // No session check. Signing out when already signed out is not an error, and answering 401
    // to it would leave a user who is confused about their state unable to reach a state they
    // are certain about.
    clearCookies(reply, secure)
    return reply.code(204).send()
  })

  app.post('/auth/token', async (request, reply) => {
    const session = cookie(request, SESSION_COOKIE)
    if (session === undefined) return reply.code(401).send({ error: 'not signed in' })

    let sub: string
    try {
      sub = verifySession(session, deps, now)
    } catch {
      return reply.code(401).send({ error: 'not signed in' })
    }

    const accessToken = mintToken(deps.key, {
      // Not interchangeable with the session cookie above, deliberately. See `TokenPurpose`.
      purpose: 'access',
      sub,
      exp: now() + ACCESS_TOKEN_TTL,
      iat: now(),
    })

    // Never cached. A token in a shared cache is a token for whoever asks next.
    reply.header('cache-control', 'no-store')
    return { accessToken, expiresIn: ACCESS_TOKEN_TTL }
  })
}

/**
 * Verifies a session token and extracts its subject.
 *
 * @param session - The session token to verify
 * @returns The subject contained in the valid session token
 */
function verifySession(session: string, deps: AuthDependencies, now: () => number): string {
  return verifyToken(session, deps.key.publicKey, 'session', now).sub
}

/**
 * Clears the authentication flow and session cookies.
 *
 * @param reply - The response to which expired cookie headers are appended
 * @param secure - Whether the cookies require the `Secure` attribute
 */
function clearCookies(reply: FastifyReply, secure: boolean): void {
  setCookie(reply, `${FLOW_COOKIE}=; ${cookieAttributes(0, secure)}`)
  setCookie(reply, `${SESSION_COOKIE}=; ${cookieAttributes(0, secure)}`)
}
