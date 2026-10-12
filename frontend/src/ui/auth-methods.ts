/**
 * What this deployment can sign in with, asked of `GET /auth/methods`.
 *
 * `read` never throws: every failure — an older API without the endpoint, a proxy error page,
 * a dead network — leaves the caller with the same move (fall back to the optimistic chooser),
 * so one `undefined` says it all, the `plans.ts` argument. There is deliberately no cache
 * document: a chooser shown offline cannot sign in whatever it offers, so a cached answer
 * would only ever advertise buttons that cannot work.
 */

export interface AuthMethods {
  readonly google: boolean
  readonly github: boolean
  readonly email: boolean
}

/** Checked by shape at the trust boundary, as `isPlanMatrix` is. */
export function isAuthMethods(body: unknown): body is AuthMethods {
  if (typeof body !== 'object' || body === null) return false
  const value = body as Record<string, unknown>
  return (
    typeof value.google === 'boolean' &&
    typeof value.github === 'boolean' &&
    typeof value.email === 'boolean'
  )
}

export interface AuthMethodsApi {
  /** The deployment's sign-in methods, or `undefined` when there is no readable answer. */
  read(): Promise<AuthMethods | undefined>
}

export function authMethodsApi(baseUrl: string, fetchImpl: typeof fetch = fetch): AuthMethodsApi {
  const base = baseUrl.replace(/\/+$/, '')
  return {
    async read(): Promise<AuthMethods | undefined> {
      let body: unknown
      try {
        const response = await fetchImpl(`${base}/auth/methods`, {
          headers: { accept: 'application/json' },
        })
        if (!response.ok) return undefined
        body = await response.json()
      } catch {
        return undefined
      }
      return isAuthMethods(body) ? body : undefined
    },
  }
}
