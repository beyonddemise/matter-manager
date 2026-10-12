/**
 * The waitlist (#224): joining it for a plan, changing the plan, and leaving it.
 *
 * **It never throws**, like `catalog.ts`. The dialog shows every failure the same way, inline,
 * so a failure is an outcome to switch on, not an exception to remember to catch. The status
 * decides the outcome, never the problem title.
 *
 * @module
 */

import type { Plan } from '../domain/plan.js'
import { isProfile, type Profile } from './profile.js'
import { accessToken } from './tokens.js'

/** What a waitlist call came to. */
export type WaitlistOutcome =
  /** Done: the profile as the server now holds it, for the cache. */
  | { readonly kind: 'done'; readonly profile: Profile }
  /** No token held, or the API said 401. */
  | { readonly kind: 'signed-out' }
  /** 409: the account already has this plan or a higher one. */
  | { readonly kind: 'already-on-plan' }
  /** A network error, any other status, or a 200 that is not a profile. */
  | { readonly kind: 'unavailable' }

/** How the waitlist is joined and left. Injected so the shell tests without a server. */
export interface WaitlistApi {
  /** Joins the waitlist for `plan`, or changes the plan already waited for. */
  join(plan: Plan): Promise<WaitlistOutcome>
  /** Leaves the waitlist. */
  leave(): Promise<WaitlistOutcome>
}

const UNAVAILABLE: WaitlistOutcome = { kind: 'unavailable' }

/**
 * The API client, in the style of `profileApi`: the access token is read when a call is made, and
 * with none held the answer is `signed-out` without a request.
 *
 * @param baseUrl `/api`, behind the application's own origin
 * @param fetchImpl injected by tests
 */
export function waitlistApi(baseUrl: string, fetchImpl: typeof fetch = fetch): WaitlistApi {
  const base = baseUrl.replace(/\/+$/, '')

  const send = async (method: 'PUT' | 'DELETE', body?: string): Promise<WaitlistOutcome> => {
    const token = accessToken()
    if (token === undefined) return { kind: 'signed-out' }

    let response: Response
    try {
      response = await fetchImpl(`${base}/waitlist`, {
        method,
        headers: {
          accept: 'application/json',
          authorization: `Bearer ${token}`,
          // Only with a body. The API refuses an empty body labelled JSON with a 400.
          ...(body === undefined ? {} : { 'content-type': 'application/json' }),
        },
        ...(body === undefined ? {} : { body }),
      })
    } catch {
      return UNAVAILABLE
    }

    if (response.status === 401) return { kind: 'signed-out' }
    if (response.status === 409) return { kind: 'already-on-plan' }
    if (!response.ok) return UNAVAILABLE

    let parsed: unknown
    try {
      parsed = await response.json()
    } catch {
      return UNAVAILABLE
    }
    return isProfile(parsed) ? { kind: 'done', profile: parsed } : UNAVAILABLE
  }

  return {
    join: (plan) => send('PUT', JSON.stringify({ plan })),
    leave: () => send('DELETE'),
  }
}
