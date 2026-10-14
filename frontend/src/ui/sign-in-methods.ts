/**
 * The account's sign-in methods, and the passkeys among them.
 *
 * `GET /auth/sign-in-methods` says which providers the account has and lists its passkeys; the
 * passkey calls register (`POST /auth/passkeys/options` → `credentials.create` →
 * `POST /auth/passkeys`), rename (`PATCH`) and remove (`DELETE`) one. Every call is
 * bearer-authenticated like `profileApi`: with no token held the answer is `signed-out` without a
 * request, and so is a 401.
 *
 * Outcomes, not exceptions, like `passkey-signin.ts`: no method rejects. **No credential id,
 * label, challenge, token or address reaches a log line or an error message** — this module does
 * not log at all.
 *
 * @module
 */

import type { CredentialsLike } from './passkey-signin.js'
import { accessToken } from './tokens.js'
import { attestationToJSON, parseCreationOptions } from './webauthn-json.js'

/** One registered passkey. Timestamps are ISO-8601, as the server wrote them. */
export interface Passkey {
  id: string
  label: string
  createdAt: string
  lastUsedAt: string
}

/** What the account can sign in with. */
export interface SignInMethods {
  google: boolean
  github: boolean
  email: boolean
  passkeys: Passkey[]
}

/** What reading the methods came to. */
export type MethodsOutcome =
  | { kind: 'methods'; methods: SignInMethods }
  /** No token held, or 401. */
  | { kind: 'signed-out' }
  | { kind: 'unreachable' }

/** What registering a passkey came to. */
export type AddOutcome =
  | { kind: 'added'; passkey: Passkey }
  /** `NotAllowedError`: the person closed the sheet — a choice, not an error. */
  | { kind: 'dismissed' }
  /** 409: the account holds as many passkeys as it may. */
  | { kind: 'full' }
  | { kind: 'signed-out' }
  | { kind: 'unreachable' }

/** What renaming or removing a passkey came to. */
export type ChangeOutcome =
  | { kind: 'done' }
  /** 404: already gone, perhaps removed on another device. */
  | { kind: 'missing' }
  | { kind: 'signed-out' }
  | { kind: 'unreachable' }

/** The sign-in-methods calls. Injected into the account view; none of them rejects. */
export interface SignInMethodsApi {
  read(): Promise<MethodsOutcome>
  add(credentials: CredentialsLike): Promise<AddOutcome>
  rename(id: string, label: string): Promise<ChangeOutcome>
  remove(id: string): Promise<ChangeOutcome>
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null

const isPasskey = (value: unknown): value is Passkey =>
  isRecord(value) &&
  typeof value.id === 'string' &&
  typeof value.label === 'string' &&
  typeof value.createdAt === 'string' &&
  typeof value.lastUsedAt === 'string'

const isSignInMethods = (value: unknown): value is SignInMethods =>
  isRecord(value) &&
  typeof value.google === 'boolean' &&
  typeof value.github === 'boolean' &&
  typeof value.email === 'boolean' &&
  Array.isArray(value.passkeys) &&
  value.passkeys.every(isPasskey)

/** The API client. `apiBase` is the path the API is served under, e.g. `/api`. */
export function signInMethodsApi(
  apiBase: string,
  fetchImpl: typeof fetch = fetch,
): SignInMethodsApi {
  const base = apiBase.replace(/\/+$/, '')

  /**
   * One bearer-authenticated request. `undefined` is "no token held" (nothing was sent);
   * `'failed'` is a network failure.
   */
  const send = async (
    method: string,
    path: string,
    body?: unknown,
  ): Promise<Response | 'failed' | undefined> => {
    const token = accessToken()
    if (token === undefined) return undefined
    try {
      return await fetchImpl(`${base}${path}`, {
        method,
        headers: {
          accept: 'application/json',
          authorization: `Bearer ${token}`,
          ...(body === undefined ? {} : { 'content-type': 'application/json' }),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      })
    } catch {
      return 'failed'
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

  /** Rename and remove share one status mapping. */
  const change = async (method: string, id: string, body?: unknown): Promise<ChangeOutcome> => {
    const response = await send(method, `/auth/passkeys/${encodeURIComponent(id)}`, body)
    if (response === undefined) return { kind: 'signed-out' }
    if (response === 'failed') return { kind: 'unreachable' }
    if (response.status === 401) return { kind: 'signed-out' }
    if (response.status === 404) return { kind: 'missing' }
    return response.ok ? { kind: 'done' } : { kind: 'unreachable' }
  }

  return {
    async read() {
      const response = await send('GET', '/auth/sign-in-methods')
      if (response === undefined) return { kind: 'signed-out' }
      if (response === 'failed') return { kind: 'unreachable' }
      if (response.status === 401) return { kind: 'signed-out' }
      if (!response.ok) return { kind: 'unreachable' }
      const body = await json(response)
      // Why: a proxy's HTML 200 or an older server must not be shown as an account with no methods.
      return isSignInMethods(body) ? { kind: 'methods', methods: body } : { kind: 'unreachable' }
    },

    async add(credentials) {
      const optionsResponse = await send('POST', '/auth/passkeys/options', {})
      if (optionsResponse === undefined) return { kind: 'signed-out' }
      if (optionsResponse === 'failed') return { kind: 'unreachable' }
      if (optionsResponse.status === 401) return { kind: 'signed-out' }
      if (!optionsResponse.ok) return { kind: 'unreachable' }
      // Why: unusable options must not open the OS sheet; the parser answers undefined for them.
      const options = parseCreationOptions(await json(optionsResponse))
      if (options === undefined) return { kind: 'unreachable' }

      let attestation: unknown
      try {
        const credential = await credentials.create(options)
        if (credential === null) return { kind: 'unreachable' }
        attestation = attestationToJSON(credential as PublicKeyCredential)
      } catch (error) {
        // Why: closing the sheet rejects with NotAllowedError; that is the person's choice and
        // must not read as a service problem. Anything else is a fault.
        if (error instanceof DOMException && error.name === 'NotAllowedError') {
          return { kind: 'dismissed' }
        }
        return { kind: 'unreachable' }
      }

      const response = await send('POST', '/auth/passkeys', attestation)
      if (response === undefined) return { kind: 'signed-out' }
      if (response === 'failed') return { kind: 'unreachable' }
      if (response.status === 401) return { kind: 'signed-out' }
      if (response.status === 409) return { kind: 'full' }
      if (response.status !== 201) return { kind: 'unreachable' }
      const passkey = await json(response)
      return isPasskey(passkey) ? { kind: 'added', passkey } : { kind: 'unreachable' }
    },

    rename: (id, label) => change('PATCH', id, { label }),
    remove: (id) => change('DELETE', id),
  }
}
