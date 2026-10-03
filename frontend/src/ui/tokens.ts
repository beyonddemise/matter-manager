/**
 * The CouchDB access token, for as long as this tab lives, and the refresh token that replaces it.
 *
 * **The access token is in memory, and nowhere else.** It is the credential the page has to put
 * in an `Authorization` header, so any script on this origin could read it; kept in a variable
 * it dies with the tab, and its five-minute life bounds what a copy is worth. See
 * `docs/tasks/todo-41.md`.
 *
 * **The refresh token is the exception, by explicit decision.** It lives in `mm-local` as a
 * `_local/` document so a reload can get a new access token without signing in again. That makes
 * it readable by any script on this origin, which is the trade-off the spec's "The trade-off of a
 * body token" accepts and bounds: it is never replicated, it is rotated on use, and sign-out
 * revokes it on the server and removes it here. The httpOnly cookies cannot do this job because
 * the page must be able to present the token itself, in a request body.
 *
 * The test that watches web storage stays: `localStorage` and `sessionStorage` still receive
 * nothing, and the only persistent copy is the one {@link pouchRefreshTokenStore} writes.
 *
 * @module
 */

/**
 * How long before its stated expiry a token stops being offered, in seconds.
 *
 * A token with two seconds left is not worth sending: the request may arrive after it has died,
 * and the resulting 401 looks like a server problem rather than an expiry. Thirty seconds is
 * comfortably longer than a slow request and far shorter than the token's life.
 */
export const EXPIRY_MARGIN_SECONDS = 30

/** What `POST /auth/token` answers with. */
export interface AccessTokenResponse {
  readonly accessToken: string
  /** Seconds until expiry, as the contract defines it. */
  readonly expiresIn: number
}

/** What `POST /auth/token` answers with: the access token and the refresh token that replaces it. */
export interface TokenResponse extends AccessTokenResponse {
  readonly refreshToken: string
}

/**
 * Where the refresh token is kept between visits.
 *
 * An interface so the exchange in `composition.ts` can be tested without a database.
 */
export interface RefreshTokenStore {
  /** The stored token, or `undefined` when none is held or the store cannot be read. */
  read(): Promise<string | undefined>
  /** Replaces the stored token. Refresh tokens rotate, so every exchange writes a new one. */
  write(token: string): Promise<void>
  /** Removes the stored token; a no-op when there is none. */
  clear(): Promise<void>
}

/** The system clock, in whole seconds — the unit JWTs and the contract both use. */
const systemClock = (): number => Math.floor(Date.now() / 1000)

let held: { readonly token: string; readonly expiresAt: number } | undefined

/**
 * Keeps a freshly minted token.
 *
 * Stores the moment it expires rather than the duration it was granted for, because the
 * duration stops being true the instant it is recorded.
 *
 * @param now the clock, injected so tests do not have to wait
 */
export function rememberAccessToken(
  response: AccessTokenResponse,
  now: () => number = systemClock,
): void {
  held = { token: response.accessToken, expiresAt: now() + response.expiresIn }
}

/**
 * The token to send, or `undefined` if there is none worth sending.
 *
 * An expired token is reported as absent rather than as an error: needing a new one is the
 * ordinary state of affairs, and the caller's response — fetch another — is the same whether
 * this tab never had one or had one that ran out.
 */
export function accessToken(now: () => number = systemClock): string | undefined {
  if (held === undefined) return undefined
  return now() < held.expiresAt - EXPIRY_MARGIN_SECONDS ? held.token : undefined
}

/**
 * Discards the token.
 *
 * Called by **both** signing out and expiring, which are otherwise nothing alike — this is the
 * one step they share, and the only one that cannot fail. See `session.ts`.
 */
export function forgetTokens(): void {
  held = undefined
}

/**
 * Keeps the refresh token in a `_local/` document of the given database.
 *
 * `_local/` documents are never replicated, so the token stays on this device even if `mm-local`
 * were ever given a remote counterpart; sign-out removes it explicitly and also destroys the
 * whole database.
 *
 * `clear` treats only a 404 as success. `read` swallows errors on purpose: an unreadable store is indistinguishable from a first visit
 * for the caller, and the worst outcome is a sign-in prompt, never a wrongly kept session.
 */
export function pouchRefreshTokenStore(db: PouchDB.Database): RefreshTokenStore {
  const id = '_local/refresh-token'
  return {
    async read() {
      try {
        return ((await db.get(id)) as unknown as { token?: string }).token
      } catch {
        return undefined
      }
    },
    async write(token) {
      let rev: string | undefined
      try {
        rev = (await db.get(id))._rev
      } catch {
        rev = undefined
      }
      await db.put({ _id: id, ...(rev === undefined ? {} : { _rev: rev }), token } as never)
    },
    async clear() {
      try {
        await db.remove(await db.get(id))
      } catch (error) {
        // Only "not there" means already gone. Anything else leaves a live credential on this
        // device, so it is rethrown for `signOut` to report rather than swallowed.
        if ((error as { status?: number }).status !== 404) throw error
      }
    },
  }
}
