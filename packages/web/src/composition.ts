/**
 * Where this application's parts are put together.
 *
 * #120 found seven modules written, tested, and imported by nothing but their own tests. Every
 * one was correct in isolation; what was missing was the file that constructs them. The story
 * that wrote each of them closed with the module reviewed and its suite green, because from the
 * inside that is exactly what a finished feature looks like.
 *
 * So this file exists to be the one place that knows how the pieces meet, and to be small enough
 * that a reader can see whether a piece is absent from it. `packages/api/src/composition.ts` is
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
import { localProfileCache, removeLocalDatabases } from './db/project-database.js'
import { type Locale, profileApi, resolveProfileLocale } from './profile.js'
import { type Project, projectsApi } from './projects.js'
import {
  endServerSessionVia,
  isSessionEnded,
  type SessionDependencies,
  type SessionState,
  signOut,
} from './session.js'
import { type ManagerDependencies, type SyncManager, syncManager } from './sync/manager.js'
import { remoteProject } from './sync/remote.js'
import type { SyncState } from './sync/replication.js'
import {
  type AccessTokenResponse,
  accessToken,
  EXPIRY_MARGIN_SECONDS,
  forgetTokens,
  rememberAccessToken,
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
export function sessionDependencies(fetchImpl: typeof fetch = fetch): SessionDependencies {
  return {
    endServerSession: endServerSessionVia(API_BASE, fetchImpl),
    removeLocalData: removeLocalDatabases,
    forgetTokens,
  }
}

/**
 * Asks the server whether this browser has a session, and keeps the token if it does.
 *
 * There is no "am I signed in" endpoint and there does not need to be: the session is an
 * httpOnly cookie the page cannot read, so the only way to find out is to try to exchange it,
 * and the exchange is a thing worth doing anyway. Asking and getting are one request.
 *
 * A 401 means signed out. Anything else — offline, a proxy in the way, the API not running —
 * is **not** an answer, and is reported as `signed-out` without discarding anything, because
 * this application works offline and being unable to reach the server is its ordinary state
 * rather than a session ending.
 */
export async function readSessionState(fetchImpl: typeof fetch = fetch): Promise<SessionState> {
  let response: Response
  try {
    response = await fetchImpl(`${API_BASE}/auth/token`, {
      method: 'POST',
      // The session is an httpOnly cookie: without this it is not sent, and the request would
      // report "not signed in" for somebody who is.
      credentials: 'include',
    })
  } catch {
    return 'signed-out'
  }

  if (isSessionEnded(response.status)) return 'signed-out'
  if (!response.ok) return 'signed-out'

  let body: unknown
  try {
    body = await response.json()
  } catch {
    return 'signed-out'
  }

  // A 200 whose body is not a token is a server fault, not a session. Reporting `signed-in` on
  // the strength of a status code would leave the application making requests with no token and
  // blaming the user's session for the 401s that follow.
  //
  // Checked by shape, not merely by parsing. The first version guarded only against JSON that
  // would not parse, which `{}` does perfectly well - and `rememberAccessToken({})` then stores
  // an undefined token with an expiry of `NaN`, so `accessToken()` reports none while this
  // function reports `signed-in`. The comment above described that guarantee; the code made a
  // weaker one, and the test picked the case the code happened to cover.
  if (!isAccessToken(body)) return 'signed-out'

  rememberAccessToken(body)
  return 'signed-in'
}

/**
 * Whether a parsed response really is an access token.
 *
 * Here rather than in `tokens.ts` because this is the trust boundary: `tokens.ts` holds a token
 * for the rest of the application and is entitled to assume it was given one. Something has to
 * make that true, and the place where a response becomes a value is it.
 */
function isAccessToken(body: unknown): body is AccessTokenResponse {
  if (typeof body !== 'object' || body === null) return false
  const { accessToken: token, expiresIn } = body as Partial<AccessTokenResponse>

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
export async function endSession(fetchImpl: typeof fetch = fetch): Promise<readonly string[]> {
  return signOut(sessionDependencies(fetchImpl))
}

/**
 * The projects this account has, from the API.
 *
 * The access token goes in an `Authorization` header rather than as a cookie, which is what the
 * contract declares — see `projects.ts` for why the session cookie would not be sent here at all.
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
