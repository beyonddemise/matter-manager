/**
 * The CouchDB access token, for as long as this tab lives.
 *
 * **In memory, and nowhere else.** Of the three credentials in this application it is the only
 * one the page can read, because PouchDB has to put it in an `Authorization` header — the PKCE
 * carrier and the session are httpOnly cookies precisely because nothing here needs them. A
 * token in `localStorage` survives the tab, is readable by any script that ever runs on this
 * origin, and grants direct access to that user's database; a token in a variable dies with the
 * tab. See `docs/tasks/todo-41.md`.
 *
 * The change that would break this is a reasonable-sounding one — "keep people signed in across
 * a reload" — so there is a test that watches web storage and fails if anything is written.
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
