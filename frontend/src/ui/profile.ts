/**
 * The signed-in user's settings, and the locale that comes from them.
 *
 * **Read through `GET /profile`, never from CouchDB.** The profile lives on the user's record in
 * `matter_manager`, which is admin-only: it also holds refresh-token hashes and plans, so no user
 * token may read it. That is why this goes through the API, and why the value has to be cached:
 * without the cache the preference is simply unavailable offline, which is unacceptable in an
 * application whose whole point is working in a basement.
 *
 * ## The order things are tried, and why
 *
 * 1. **The cache**, immediately and synchronously enough to render with. A page that renders in
 *    English and switches to German a second later is worse than one that waits, and far worse
 *    than one that was simply right.
 * 2. **The server**, in the background. If it disagrees, the cache is corrected and the
 *    interface follows.
 * 3. **The browser's own languages**, when there is neither — which is what `auto` means and
 *    what a first visit gets.
 *
 * @module
 */

import type { CachedProfile, LocalCache } from '../data/index.js'
import { isPlan, isWaitlistPlan, type Plan, planOf } from '../domain/plan.js'
import { accessToken } from './tokens.js'

/** What a user may choose, matching the contract's enum. */
export type Locale = 'auto' | 'en' | 'de'

/** The profile as `GET /profile` returns it. */
export interface Profile {
  readonly sub: string
  readonly email: string
  readonly displayName: string
  readonly locale: Locale
  /** The account's plan. */
  readonly plan: Plan
  /** Projects the account may own; `-1` is unlimited. */
  readonly projectLimit: number
  /** The plan the account is waiting for (#224); absent unless it is on the waitlist. */
  readonly planRequested?: Plan
  /** When it joined the waitlist or last changed the plan, ISO-8601. */
  readonly requestedAt?: string
}

const LOCALES: readonly string[] = ['auto', 'en', 'de']

const isLocale = (value: unknown): value is Locale =>
  typeof value === 'string' && LOCALES.includes(value)

/** How the profile is fetched and saved. Injected so views test without a server. */
export interface ProfileApi {
  read(): Promise<Profile | undefined>
  update(update: { locale: Locale }): Promise<Profile>
}

/**
 * The API client.
 *
 * The access token goes in an `Authorization` header, which is what the contract declares. With
 * no token held — signed out, or between a token's expiry and its refresh — `read` answers
 * `undefined` without a request, the same "not signed in" an unauthenticated call would earn.
 */
export function profileApi(baseUrl: string, fetchImpl: typeof fetch = fetch): ProfileApi {
  const base = baseUrl.replace(/\/+$/, '')

  return {
    async read(): Promise<Profile | undefined> {
      const token = accessToken()
      if (token === undefined) return undefined
      const response = await fetchImpl(`${base}/profile`, {
        headers: { accept: 'application/json', authorization: `Bearer ${token}` },
      })
      // 401 is "not signed in", which is an ordinary state rather than a failure — most of this
      // application works without an account.
      if (response.status === 401) return undefined
      if (!response.ok) throw new Error(`The profile could not be read (${response.status}).`)
      return (await response.json()) as Profile
    },

    async update(update: { locale: Locale }): Promise<Profile> {
      const response = await fetchImpl(`${base}/profile`, {
        method: 'PATCH',
        headers: {
          'content-type': 'application/json',
          accept: 'application/json',
          authorization: `Bearer ${accessToken() ?? ''}`,
        },
        body: JSON.stringify(update),
      })
      if (!response.ok) throw new Error(`The change could not be saved (${response.status}).`)
      return (await response.json()) as Profile
    },
  }
}

/** The cached profile as a locale, or `undefined` when nothing is cached. */
export function cachedLocale(cached: CachedProfile | undefined): Locale | undefined {
  return cached !== undefined && isLocale(cached.locale) ? cached.locale : undefined
}

/** The cached profile's plan; `free` on a device that never signed in or holds an unknown one. */
export function cachedPlan(cached: CachedProfile | undefined): Plan {
  return planOf(cached?.plan)
}

/** A plan the account is waiting for, and since when (#224). */
export interface PlanRequest {
  readonly plan: Plan
  /** ISO-8601, as the server wrote it. */
  readonly at: string
}

/**
 * The optional waitlist pair is all or nothing: both absent, or a plan that can be waited for
 * with its date. A half pair would be cached as junk, so it rejects the whole body.
 */
function isWaitlistPair(plan: unknown, at: unknown): boolean {
  if (plan === undefined && at === undefined) return true
  return isWaitlistPlan(plan) && typeof at === 'string'
}

/**
 * Whether a parsed body is a profile. Checked by shape at the trust boundary, as
 * `isCatalogLookup` does: a proxy's HTML page or an older server must not be cached as one.
 */
export function isProfile(body: unknown): body is Profile {
  if (typeof body !== 'object' || body === null) return false
  const value = body as Record<string, unknown>
  return (
    typeof value.sub === 'string' &&
    typeof value.email === 'string' &&
    typeof value.displayName === 'string' &&
    isLocale(value.locale) &&
    isPlan(value.plan) &&
    typeof value.projectLimit === 'number' &&
    isWaitlistPair(value.planRequested, value.requestedAt)
  )
}

/**
 * A profile in the shape `mm-local` caches it. `auto` is stored as no locale, and the waitlist
 * pair is stored only when both halves are present.
 */
export function cachedProfileOf(profile: Profile, fetchedAt: string): CachedProfile {
  return {
    sub: profile.sub,
    ...(profile.locale === 'auto' ? {} : { locale: profile.locale }),
    email: profile.email,
    name: profile.displayName,
    plan: profile.plan,
    projectLimit: profile.projectLimit,
    ...(profile.planRequested === undefined || profile.requestedAt === undefined
      ? {}
      : { planRequested: profile.planRequested, requestedAt: profile.requestedAt }),
    fetchedAt,
  }
}

/**
 * The cached waitlist request, or `undefined` when the account is not waiting or the cache holds
 * something this build cannot read. Unlike {@link cachedPlan}, an unknown value is no request
 * rather than a default: there is nothing safe to wait for in its place.
 */
export function cachedRequest(cached: CachedProfile | undefined): PlanRequest | undefined {
  const plan = cached?.planRequested
  const at = cached?.requestedAt
  return isWaitlistPlan(plan) && typeof at === 'string' ? { plan, at } : undefined
}

/**
 * Loads the profile, preferring the cache and correcting it from the server.
 *
 * @param onChange called when the server's answer differs from what was cached — which is how
 *   a preference set on a phone reaches a laptop without a reload.
 * @param onCached called once the server's answer has been written to the cache (or the write
 *   was refused), so whatever else reads the cached profile — the email, the plan — reads again.
 * @returns what the interface should use *now*: the cached locale if there is one, so the first
 *   render is right rather than corrected a moment later.
 */
export async function resolveProfileLocale(
  api: ProfileApi,
  cache: LocalCache,
  onChange: (locale: Locale) => void,
  now: () => string = () => new Date().toISOString(),
  onCached?: () => void,
): Promise<Locale | undefined> {
  let cached: CachedProfile | undefined
  try {
    cached = await cache.readProfile()
  } catch {
    // An unreadable cache is not a reason to be unusable. The server is asked below, and a
    // first visit looks exactly like this anyway.
    cached = undefined
  }

  const immediate = cachedLocale(cached)

  // Not awaited by the caller's rendering path. Fetching the profile before the first paint
  // would put a network round trip in front of an application that is meant to open offline.
  void (async () => {
    let profile: Profile | undefined
    try {
      profile = await api.read()
    } catch {
      // Offline, or the server is unwell. The cached answer stands, which is the entire point
      // of having one.
      return
    }
    if (profile === undefined) return

    await cache.writeProfile(cachedProfileOf(profile, now())).catch(() => {
      // A cache that will not accept a write still leaves this session correct.
    })

    onCached?.()
    if (profile.locale !== (immediate ?? 'auto')) onChange(profile.locale)
  })()

  return immediate
}
