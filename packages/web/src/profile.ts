/**
 * The signed-in user's settings, and the locale that comes from them.
 *
 * **Read through `GET /profile`, never from CouchDB.** A JWT-authenticated browser cannot read
 * `_users` at all — not even its own document; it gets a 403, verified against CouchDB 3.5.2.
 * That is why this goes through the API, and why the value has to be cached: without the cache
 * the preference is simply unavailable offline, which is unacceptable in an application whose
 * whole point is working in a basement.
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

import type { CachedProfile, LocalCache } from '@matter-manager/data'

/** What a user may choose, matching the contract's enum. */
export type Locale = 'auto' | 'en' | 'de'

/** The profile as `GET /profile` returns it. */
export interface Profile {
  readonly sub: string
  readonly email: string
  readonly displayName: string
  readonly locale: Locale
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
 * `credentials: 'include'` because the session is an httpOnly cookie — the page cannot read it
 * and therefore cannot send it any other way. Without this the request goes out unauthenticated
 * and answers 401, which reads as "signed out" on a page that is signed in.
 */
export function profileApi(baseUrl: string, fetchImpl: typeof fetch = fetch): ProfileApi {
  const base = baseUrl.replace(/\/+$/, '')

  return {
    async read(): Promise<Profile | undefined> {
      const response = await fetchImpl(`${base}/profile`, {
        credentials: 'include',
        headers: { accept: 'application/json' },
      })
      // 401 is "not signed in", which is an ordinary state rather than a failure — most of this
      // application works without an account.
      if (response.status === 401) return undefined
      if (!response.ok) throw new Error(`The profile could not be read (${response.status}).`)
      return (await response.json()) as Profile
    },

    async update(update: { locale: Locale }): Promise<Profile> {
      const response = await fetchImpl(`${base}/profile`, {
        method: 'PUT',
        credentials: 'include',
        headers: { 'content-type': 'application/json', accept: 'application/json' },
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

/**
 * Loads the profile, preferring the cache and correcting it from the server.
 *
 * @param onChange called when the server's answer differs from what was cached — which is how
 *   a preference set on a phone reaches a laptop without a reload.
 * @returns what the interface should use *now*: the cached locale if there is one, so the first
 *   render is right rather than corrected a moment later.
 */
export async function resolveProfileLocale(
  api: ProfileApi,
  cache: LocalCache,
  onChange: (locale: Locale) => void,
  now: () => string = () => new Date().toISOString(),
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

    await cache
      .writeProfile({
        sub: profile.sub,
        ...(profile.locale === 'auto' ? {} : { locale: profile.locale }),
        email: profile.email,
        name: profile.displayName,
        fetchedAt: now(),
      })
      .catch(() => {
        // A cache that will not accept a write still leaves this session correct.
      })

    if (profile.locale !== (immediate ?? 'auto')) onChange(profile.locale)
  })()

  return immediate
}
