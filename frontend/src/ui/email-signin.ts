/**
 * Signing in with an emailed one-time code, without leaving the page.
 *
 * Two calls: `start` asks `POST /auth/email` to mail a six-digit code and answers a random
 * *challenge id*; `complete` presents that id and the typed code at `POST /auth/email/{challenge}`
 * and receives the same token pair `POST /auth/token` answers. The secret is split across the two
 * channels — the code travels only in the email, the challenge id only in the start answer — so
 * neither alone signs anybody in.
 *
 * Outcomes, not exceptions, like `waitlist.ts`: every answer the dialog has to distinguish is a
 * named kind, and nothing here throws — a sign-in dialog has a next step for every outcome, and
 * an exception would turn "the service is down" into a broken dialog. **No address, challenge id
 * or code reaches a log line or an error message**; the outcomes carry no fields the dialog does
 * not need.
 *
 * @module
 */

import {
  forgetTokens,
  isTokenResponse,
  type RefreshTokenStore,
  rememberAccessToken,
} from './tokens.js'

/** What starting a sign-in came to. */
export type StartOutcome =
  /** The code is in the mail; verification needs this id. */
  | { kind: 'challenge'; challenge: string }
  /** 400: not an address the server takes. */
  | { kind: 'refused' }
  /** 429: too many codes for this address — wait before asking again. */
  | { kind: 'throttled' }
  /** 404: this deployment has no email sign-in (yet). The dialog hides the option. */
  | { kind: 'unavailable' }
  /** Network failure, 5xx, or an answer that is not the contract's. */
  | { kind: 'unreachable' }

/** What verifying the code came to. */
export type VerifyOutcome =
  /** The tokens are held; the shell runs its refreshed transition. */
  | { kind: 'signed-in'; expiresIn: number }
  /** 401, one kind for every refusal — wrong, expired, consumed and unknown look the same. */
  | { kind: 'failed' }
  | { kind: 'unreachable' }

/** The two steps of the email flow. Injected into the shell, so tests need no server. */
export interface EmailSignIn {
  start(email: string, locale: string): Promise<StartOutcome>
  complete(challenge: string, code: string): Promise<VerifyOutcome>
}

/**
 * The API client.
 *
 * `complete` is the one place outside the token refresher that adopts a token pair: on success it
 * remembers the access token and stores the refresh token before reporting, so by the time the
 * shell hears `signed-in` the session can already speak.
 */
export function emailSignIn(
  apiBase: string,
  store: RefreshTokenStore,
  fetchImpl: typeof fetch = fetch,
): EmailSignIn {
  const post = async (path: string, body: unknown): Promise<Response | undefined> => {
    try {
      return await fetchImpl(`${apiBase}${path}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      })
    } catch {
      return undefined
    }
  }

  return {
    async start(email, locale) {
      const response = await post('/auth/email', { email, locale })
      if (response === undefined) return { kind: 'unreachable' }
      if (response.status === 400) return { kind: 'refused' }
      if (response.status === 404) return { kind: 'unavailable' }
      if (response.status === 429) return { kind: 'throttled' }
      if (!response.ok) return { kind: 'unreachable' }
      let body: unknown
      try {
        body = await response.json()
      } catch {
        return { kind: 'unreachable' }
      }
      const challenge = (body as { challenge?: unknown }).challenge
      // A 202 without a challenge is a server fault, not a flow state.
      if (typeof challenge !== 'string' || challenge === '') return { kind: 'unreachable' }
      return { kind: 'challenge', challenge }
    },

    async complete(challenge, code) {
      const response = await post(`/auth/email/${encodeURIComponent(challenge)}`, { code })
      if (response === undefined) return { kind: 'unreachable' }
      // A 400 refuses the code's shape, a 401 the code itself; to the person at the dialog both
      // are "the code didn't work", not a service problem.
      if (response.status === 400 || response.status === 401) return { kind: 'failed' }
      if (!response.ok) return { kind: 'unreachable' }
      let body: unknown
      try {
        body = await response.json()
      } catch {
        return { kind: 'unreachable' }
      }
      // The same trust boundary the refresher guards: a 200 that is not a token pair is a
      // server fault, and believing it would store a session that cannot speak.
      if (!isTokenResponse(body)) return { kind: 'unreachable' }
      rememberAccessToken(body)
      try {
        await store.write(body.refreshToken)
      } catch {
        // Half a sign-in is worse than none: an access token held without its refresh token
        // would die in minutes with nothing to renew it, while the caller heard "success".
        forgetTokens()
        return { kind: 'unreachable' }
      }
      return { kind: 'signed-in', expiresIn: body.expiresIn }
    },
  }
}
