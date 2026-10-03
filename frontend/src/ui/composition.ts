/**
 * Where this application's parts are put together.
 *
 * #120 found seven modules written, tested, and imported by nothing but their own tests. Every
 * one was correct in isolation; what was missing was the file that constructs them. The story
 * that wrote each of them closed with the module reviewed and its suite green, because from the
 * inside that is exactly what a finished feature looks like.
 *
 * So this file exists to be the one place that knows how the pieces meet, and to be small enough
 * that a reader can see whether a piece is absent from it. `backend/src/composition.ts` is
 * the same idea on the other side, for the same reason.
 *
 * **Both back ends are addressed by path, never by host.** In production the application keeps
 * its Cloudflare Pages deployment and Pages Functions forward `/api` and `/db`; in development
 * Vite proxies the same two paths. So nothing here needs a hostname, `connect-src 'self'` covers
 * every request the application makes, and there is no build-time origin to get wrong. A URL
 * that worked in one of the two places and not the other would be a bug nobody meets until the
 * deploy.
 *
 * @module
 */

import PouchDB from 'pouchdb-browser'
import { localDatabase, localProfileCache, removeLocalDatabases } from './db/project-database.js'
import { type Locale, profileApi, resolveProfileLocale } from './profile.js'
import { type Project, projectsApi } from './projects.js'
import {
  endServerSessionVia,
  isSessionEnded,
  type SessionDependencies,
  signOut,
} from './session.js'
import { type ManagerDependencies, type SyncManager, syncManager } from './sync/manager.js'
import { remoteProject } from './sync/remote.js'
import type { SyncState } from './sync/replication.js'
import {
  accessToken,
  EXPIRY_MARGIN_SECONDS,
  forgetTokens,
  pouchRefreshTokenStore,
  type RefreshTokenStore,
  rememberAccessToken,
  type TokenResponse,
} from './tokens.js'

/** The API, behind the application's own origin. See the module note. */
export const API_BASE = '/api'

/** CouchDB, likewise. Used when replication is wired. */
export const COUCH_BASE = '/db'

/**
 * Everything signing out has to reach.
 *
 * The two halves are deliberately assembled here rather than in `session.ts`: that module has to
 * stay loadable outside a browser — which is what lets its tests run in plain Node — so it can
 * hold the *policy* and none of the PouchDB.
 */
export function sessionDependencies(
  fetchImpl: typeof fetch,
  includeLocalCatalogue: boolean,
  store: RefreshTokenStore,
  held: HeldCredentials,
): SessionDependencies {
  return {
    endServerSession: endServerSessionVia(
      API_BASE,
      fetchImpl,
      { read: async () => held.refreshToken, write: async () => {}, clear: async () => {} },
      () => held.bearer,
    ),
    // The catalogue on this device predates accounts and holds whatever was recorded before
    // signing in, so it is kept unless the reader asked otherwise. On a shared machine somebody
    // may well want it gone, which is why the sign-out control asks rather than this deciding
    // (#55). Everything the *account* put on this browser goes either way.
    removeLocalData: () => removeLocalDatabases({ includeLocalCatalogue }),
    forgetTokens,
    forgetRefreshToken: () => store.clear(),
  }
}

/**
 * The credentials the server has to be shown to revoke them.
 *
 * Captured by {@link endSession} before `signOut` starts, because `signOut` discards both
 * locally first (the steps that cannot fail), after which there would be nothing left to send.
 */
export interface HeldCredentials {
  readonly refreshToken?: string | undefined
  readonly bearer?: string | undefined
}

/** What {@link requestTokens} found out. */
export type TokenOutcome =
  | { readonly kind: 'refreshed'; readonly expiresIn: number }
  /** Never signed in on this device, or the handoff was refused. */
  | { readonly kind: 'signed-out' }
  /** A stored refresh token was refused: an authentication failure, not a choice. */
  | { readonly kind: 'ended' }
  /** Network error, timeout, 5xx or an unusable answer. Nothing was discarded. */
  | { readonly kind: 'unreachable' }

/**
 * Gets an access token, and keeps the refresh token that comes with it.
 *
 * There is no "am I signed in" endpoint and there does not need to be: the exchange is the
 * question. The first call after sign-in has no stored token and authenticates with the httpOnly
 * handoff cookie, which is why `credentials: 'include'` stays; every later call sends the stored
 * refresh token in the body. The server does **not** rotate it (#209), so ordinarily the same
 * token comes back. It differs after a fresh sign-in: a handoff that verifies wins over the body
 * token on the server, and the new refresh token it returns replaces the stored one — which is
 * why the answer is written back whenever it differs.
 *
 * Only a 401 ends anything. Offline, a proxy in the way or a 5xx is **not** an answer and
 * reports `unreachable` without discarding the stored token, because this application works
 * offline and an unwell server must not sign anybody out.
 *
 * @param signal aborted when nobody wants the answer any more (the refresher was stopped, which
 *   is what signing out does). Checked before every side effect, not only passed to `fetch`:
 *   a response already received would otherwise still remember the access token and write the
 *   returned refresh token *after* sign-out cleared both, re-arming a signed-out browser. An
 *   aborted request reports `unreachable` and changes nothing.
 */
export async function requestTokens(
  store: RefreshTokenStore,
  fetchImpl: typeof fetch = fetch,
  signal?: AbortSignal,
): Promise<TokenOutcome> {
  // A function, not repeated property reads: TypeScript would narrow `signal.aborted` after the
  // first check and call the later ones impossible, though it can change across every `await`.
  const aborted = (): boolean => signal?.aborted === true
  const stored = await store.read()
  if (aborted()) return { kind: 'unreachable' }
  let response: Response
  try {
    response = await fetchImpl(`${API_BASE}/auth/token`, {
      method: 'POST',
      // The handoff cookie is httpOnly and must be sent on the first call after sign-in.
      credentials: 'include',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(stored === undefined ? {} : { refreshToken: stored }),
      ...(signal === undefined ? {} : { signal }),
    })
  } catch {
    return { kind: 'unreachable' }
  }
  if (aborted()) return { kind: 'unreachable' }

  if (isSessionEnded(response.status)) {
    if (stored === undefined) return { kind: 'signed-out' }
    await store.clear()
    return { kind: 'ended' }
  }
  if (!response.ok) return { kind: 'unreachable' }

  let body: unknown
  try {
    body = await response.json()
  } catch {
    return { kind: 'unreachable' }
  }
  // Again after the body: reading it is asynchronous too, and this is the last point before the
  // state changes.
  if (aborted()) return { kind: 'unreachable' }

  // A 200 whose body is not a token pair is a server fault, not a session, so it is
  // `unreachable` rather than `signed-out`: the server being unwell must not sign anybody out.
  //
  // Checked by shape, not merely by parsing. Guarding only against JSON that will not parse lets
  // `{}` through, and `rememberAccessToken({})` then stores an undefined token with an expiry of
  // `NaN`, so `accessToken()` reports none while this function reports success.
  if (!isTokenResponse(body)) return { kind: 'unreachable' }

  rememberAccessToken(body)
  if (body.refreshToken !== stored) await store.write(body.refreshToken)
  return { kind: 'refreshed', expiresIn: body.expiresIn }
}

/**
 * Whether a parsed response really is a token pair: an access token and a refresh token.
 *
 * Here rather than in `tokens.ts` because this is the trust boundary: `tokens.ts` holds a token
 * for the rest of the application and is entitled to assume it was given one. Something has to
 * make that true, and the place where a response becomes a value is it.
 */
function isTokenResponse(body: unknown): body is TokenResponse {
  if (typeof body !== 'object' || body === null) return false
  const { accessToken: token, expiresIn, refreshToken } = body as Partial<TokenResponse>

  // Likewise for the refresh token: without one the next reload could not sign in again.
  if (typeof refreshToken !== 'string' || refreshToken === '') return false

  // An empty token is not a token: it would be sent as `Authorization: Bearer `, refused, and
  // reported as an expiry - sending the user round a sign-in loop that cannot help them.
  if (typeof token !== 'string' || token === '') return false

  // `Number.isFinite` rather than a type check alone. `expiresIn` becomes `now() + expiresIn`,
  // so a NaN or an Infinity there is an expiry that either never passes or has already passed,
  // and both are worse than having no token at all.
  if (typeof expiresIn !== 'number' || !Number.isFinite(expiresIn)) return false

  // Against the margin, not against zero. `accessToken()` withholds a token with less than
  // `EXPIRY_MARGIN_SECONDS` left - a token that may die in flight produces a 401 that looks like
  // a server fault rather than an expiry - so anything at or below the margin is a token this
  // application will never send. Storing one and reporting `signed-in` would be the same
  // divergence as believing an empty body: a session that says yes and a token that says no.
  //
  // Derived from the constant rather than repeating 30, so the two cannot drift apart.
  return expiresIn > EXPIRY_MARGIN_SECONDS
}

/**
 * Starts the sign-in journey.
 *
 * A full-page navigation rather than a fetch, because the destination is Google's consent screen
 * and the return trip sets an httpOnly cookie. Neither can happen inside XHR.
 *
 * @param go injected so a test does not navigate the page it is running in
 */
export function beginSignIn(
  go: (url: string) => void = (url) => window.location.assign(url),
): void {
  go(`${API_BASE}/auth/google`)
}

/**
 * Signs out, and says what went wrong without pretending it did not happen.
 *
 * `signOut` never throws by design — a sign-out that reports an error leaves the user unsure
 * whether they are signed out, and their reasonable next move, closing the tab, leaves them
 * signed in.
 */
export async function endSession(
  includeLocalCatalogue = false,
  fetchImpl: typeof fetch = fetch,
  store: RefreshTokenStore = pouchRefreshTokenStore(localDatabase()),
): Promise<readonly string[]> {
  // Awaited here, before `signOut`, so the order is explicit: `signOut` clears the stored
  // refresh token and the in-memory access token before it asks the server to revoke them. A
  // store that cannot be read means there is nothing to revoke, not a reason to stay signed in.
  const held: HeldCredentials = {
    refreshToken: await store.read().catch(() => undefined),
    bearer: accessToken(),
  }
  return signOut(sessionDependencies(fetchImpl, includeLocalCatalogue, store, held))
}

/**
 * The projects this account has, from the API.
 *
 * The access token goes in an `Authorization` header, which is what the contract declares — see
 * `projects.ts` for why no cookie authenticates these routes.
 */
export function projects(fetchImpl: typeof fetch = fetch): ReturnType<typeof projectsApi> {
  return projectsApi(API_BASE, accessToken, fetchImpl)
}

/** The profile, which carries the locale preference across devices. */
export function profile(fetchImpl: typeof fetch = fetch): ReturnType<typeof profileApi> {
  return profileApi(API_BASE, fetchImpl)
}

/**
 * Replication for whichever projects are handed to it.
 *
 * This is the one place PouchDB meets the sync modules. `sync/replication.ts` and
 * `sync/manager.ts` deliberately declare the slivers of PouchDB they use as their own interfaces
 * rather than importing it, which is what lets their tests run without a database — so something
 * has to supply the real thing, and this is it.
 */
export function projectSync(
  onState?: (projectId: string, state: SyncState) => void,
  onIncoming?: (projectId: string) => void,
): SyncManager {
  return syncManager({
    // `as unknown as` because `sync/replication.ts` declares only the sliver of PouchDB it
    // uses - which is what lets its tests run without a database - and a structural match
    // against PouchDB's much larger surface is not something TypeScript will infer.
    local: (dbName) => new PouchDB(dbName) as unknown as ReturnType<ManagerDependencies['local']>,
    remote: (dbName) =>
      remoteProject(dbName, {
        couchUrl: COUCH_BASE,
        token: accessToken,
        open: (url, options) => new PouchDB(url, { fetch: options.fetch }),
      }),
    ...(onState === undefined ? {} : { onState }),
    ...(onIncoming === undefined ? {} : { onIncoming }),
  })
}

/**
 * Follows the locale the profile carries, so a preference set on a phone reaches a laptop.
 *
 * Returns the cached answer immediately and corrects it when the server replies, which is what
 * keeps the first render right rather than corrected a moment later. Never throws: a profile
 * that cannot be read is a reason to keep the local preference, not a reason to fail.
 */
export async function followProfileLocale(
  onChange: (locale: Locale) => void,
  fetchImpl: typeof fetch = fetch,
): Promise<Locale | undefined> {
  try {
    return await resolveProfileLocale(profile(fetchImpl), localProfileCache(), onChange)
  } catch {
    return undefined
  }
}

/** What replication needs to know about one project. */
export type ReplicatingProject = Pick<Project, 'projectId' | 'dbName'>
