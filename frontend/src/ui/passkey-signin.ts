/**
 * Signing in with a passkey, without leaving the page.
 *
 * One ceremony, two calls: `POST /auth/passkey/options` answers a WebAuthn challenge, the browser
 * asks the authenticator to sign it (`credentials.get`), and `POST /auth/passkey` presents the
 * assertion and receives the same token pair `POST /auth/token` answers. The challenge is bound
 * to the browser by a same-origin cookie, which is why neither call sets `credentials` — the
 * default already carries it.
 *
 * Outcomes, not exceptions, like `email-signin.ts`: nothing here throws, so the dialog has a next
 * step for every answer. **No credential id, challenge, token or address reaches a log line or an
 * error message** — this module does not log at all.
 *
 * @module
 */

import {
  forgetTokens,
  isTokenResponse,
  type RefreshTokenStore,
  rememberAccessToken,
} from './tokens.js'
import { assertionToJSON, parseRequestOptions } from './webauthn-json.js'

/** The subset of `navigator.credentials` the ceremonies need. Injected, so tests need no authenticator. */
export interface CredentialsLike {
  get(options: CredentialRequestOptions): Promise<Credential | null>
  create(options: CredentialCreationOptions): Promise<Credential | null>
}

/** What a passkey sign-in came to. */
export type PasskeySignInOutcome =
  /** The tokens are held; the shell runs its refreshed transition. */
  | { kind: 'signed-in'; expiresIn: number }
  /** `NotAllowedError`: the person closed the sheet — a choice, not an error. */
  | { kind: 'dismissed' }
  /** 401: the one indistinguishable refusal. */
  | { kind: 'failed' }
  /** 404: this deployment has no passkeys. The dialog hides the option. */
  | { kind: 'unavailable' }
  /** Network failure, 5xx, a failed ceremony, or an answer that is not the contract's. */
  | { kind: 'unreachable' }

/** The passkey flow. Injected into the shell, so tests need no server and no authenticator. */
export interface PasskeySignIn {
  /** Runs the whole ceremony. Never rejects. */
  signIn(): Promise<PasskeySignInOutcome>
}

/**
 * The API client.
 *
 * Like `emailSignIn(...).complete`, a successful `signIn` remembers the access token and stores
 * the refresh token before reporting, so the session can already speak when the shell hears
 * `signed-in`.
 */
export function passkeySignIn(
  apiBase: string,
  store: RefreshTokenStore,
  credentials: CredentialsLike,
  fetchImpl: typeof fetch = fetch,
): PasskeySignIn {
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

  /** The response body as JSON, or `undefined` when it is not JSON. */
  const json = async (response: Response): Promise<unknown> => {
    try {
      return await response.json()
    } catch {
      return undefined
    }
  }

  return {
    async signIn() {
      const optionsResponse = await post('/auth/passkey/options', {})
      if (optionsResponse === undefined) return { kind: 'unreachable' }
      if (optionsResponse.status === 404) return { kind: 'unavailable' }
      if (!optionsResponse.ok) return { kind: 'unreachable' }
      // Why: a proxy's HTML 200 must not open the OS sheet; the parser answers undefined for it.
      const options = parseRequestOptions(await json(optionsResponse))
      if (options === undefined) return { kind: 'unreachable' }

      let assertion: unknown
      try {
        const credential = await credentials.get(options)
        if (credential === null) return { kind: 'unreachable' }
        assertion = assertionToJSON(credential as PublicKeyCredential)
      } catch (error) {
        // Why: closing the sheet rejects with NotAllowedError; that is the person's choice and
        // must not read as a service problem. Anything else is a fault.
        if (error instanceof DOMException && error.name === 'NotAllowedError') {
          return { kind: 'dismissed' }
        }
        return { kind: 'unreachable' }
      }

      const response = await post('/auth/passkey', assertion)
      if (response === undefined) return { kind: 'unreachable' }
      if (response.status === 401) return { kind: 'failed' }
      if (!response.ok) return { kind: 'unreachable' }
      const body = await json(response)
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
