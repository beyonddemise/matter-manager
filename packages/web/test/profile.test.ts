import type { CachedProfile, LocalCache } from '@matter-manager/data'
import { describe, expect, it } from 'vitest'
import {
  cachedLocale,
  type Locale,
  type Profile,
  profileApi,
  resolveProfileLocale,
} from '../src/profile.js'

const PROFILE: Profile = {
  sub: 'google|1234',
  email: 'ada@example.com',
  displayName: 'Ada',
  locale: 'de',
}

/** A cache backed by a variable, so a test can start it full, empty or broken. */
function fakeCache(initial?: CachedProfile, broken = false) {
  let stored = initial
  const writes: CachedProfile[] = []
  const cache: LocalCache = {
    async readProfile() {
      if (broken) throw new Error('the cache is unreadable')
      return stored
    },
    async writeProfile(profile) {
      writes.push(profile)
      stored = profile
    },
    async clear() {
      stored = undefined
    },
  }
  return { cache, writes, current: () => stored }
}

/** Lets a test wait for the background correction without knowing how long it takes. */
const settled = () => new Promise((resolve) => setTimeout(resolve, 0))

describe('the cached locale', () => {
  it('is the one that was cached', () => {
    expect(cachedLocale({ sub: 'x', locale: 'de', fetchedAt: '2026-08-27T00:00:00.000Z' })).toBe(
      'de',
    )
  })

  it('is nothing when nothing is cached', () => {
    expect(cachedLocale(undefined)).toBeUndefined()
  })

  it('is nothing for a value this build cannot honour', () => {
    // A cache written by a build that had a language this one does not. Following the browser
    // is the honest fallback.
    expect(
      cachedLocale({ sub: 'x', locale: 'fr', fetchedAt: '2026-08-27T00:00:00.000Z' }),
    ).toBeUndefined()
  })
})

describe('resolving the locale to render with', () => {
  const api = (profile: Profile | undefined) => ({
    read: async () => profile,
    update: async () => PROFILE,
  })

  it('uses the cache immediately, without waiting for the server', async () => {
    // The whole reason the cache exists. A page that renders in English and switches to German
    // a second later is worse than one that waits, and far worse than one that was right.
    const { cache } = fakeCache({ sub: 'google|1234', locale: 'de', fetchedAt: 'x' })
    const slow = {
      read: () => new Promise<Profile>(() => {}),
      update: async () => PROFILE,
    }

    expect(await resolveProfileLocale(slow, cache, () => {})).toBe('de')
  })

  it('answers nothing on a first visit, which means follow the browser', async () => {
    const { cache } = fakeCache()

    expect(await resolveProfileLocale(api(undefined), cache, () => {})).toBeUndefined()
  })

  it('fills the cache from the server', async () => {
    const { cache, writes } = fakeCache()
    await resolveProfileLocale(api(PROFILE), cache, () => {})
    await settled()

    expect(writes[0]).toMatchObject({ sub: 'google|1234', locale: 'de', name: 'Ada' })
  })

  it('reports a change the server knows about and the cache did not', async () => {
    // How a preference set on a phone reaches a laptop without a reload.
    const { cache } = fakeCache({ sub: 'google|1234', locale: 'en', fetchedAt: 'x' })
    const changes: Locale[] = []

    await resolveProfileLocale(api(PROFILE), cache, (locale) => changes.push(locale))
    await settled()

    expect(changes).toEqual(['de'])
  })

  it('says nothing when the server agrees with the cache', async () => {
    // A change event for a value that did not change would re-render the whole interface for
    // nothing, on every load.
    const { cache } = fakeCache({ sub: 'google|1234', locale: 'de', fetchedAt: 'x' })
    const changes: Locale[] = []

    await resolveProfileLocale(api(PROFILE), cache, (locale) => changes.push(locale))
    await settled()

    expect(changes).toEqual([])
  })

  it('does not store auto as a locale', async () => {
    // `auto` is the absence of a preference. Storing it would make "never chose" and "chose to
    // follow the browser" different states that behave identically.
    const { cache, writes } = fakeCache()
    await resolveProfileLocale(api({ ...PROFILE, locale: 'auto' }), cache, () => {})
    await settled()

    expect(writes[0]?.locale).toBeUndefined()
  })

  it('keeps the cached answer when the server cannot be reached', async () => {
    // The issue's second scenario. This is what "my locale is available offline" means.
    const { cache } = fakeCache({ sub: 'google|1234', locale: 'de', fetchedAt: 'x' })
    const offline = {
      read: async () => {
        throw new TypeError('Failed to fetch')
      },
      update: async () => PROFILE,
    }

    const locale = await resolveProfileLocale(offline, cache, () => {})
    await settled()

    expect(locale).toBe('de')
  })

  it('survives an unreadable cache', async () => {
    // Not a reason to be unusable: a first visit looks exactly like this anyway.
    const { cache } = fakeCache(undefined, true)

    expect(await resolveProfileLocale(api(PROFILE), cache, () => {})).toBeUndefined()
  })

  it('survives a cache that will not accept a write', async () => {
    const cache: LocalCache = {
      readProfile: async () => undefined,
      writeProfile: async () => {
        throw new Error('quota')
      },
      clear: async () => {},
    }
    const changes: Locale[] = []

    await resolveProfileLocale(api(PROFILE), cache, (locale) => changes.push(locale))
    await settled()

    // The session is still correct even though nothing was remembered for the next one.
    expect(changes).toEqual(['de'])
  })
})

describe('talking to the profile endpoint', () => {
  function recording(status: number, body: unknown) {
    const calls: Array<{
      url: string
      method: string
      credentials: string | undefined
      body: string | undefined
    }> = []
    const impl = (async (url: string | URL, init?: RequestInit) => {
      calls.push({
        url: String(url),
        method: init?.method ?? 'GET',
        credentials: init?.credentials,
        body: typeof init?.body === 'string' ? init.body : undefined,
      })
      return { ok: status < 400, status, json: async () => body } as Response
    }) as unknown as typeof fetch
    return { impl, calls }
  }

  it('sends the session cookie', async () => {
    // The session is httpOnly — the page cannot read it and therefore cannot send it any other
    // way. Without `credentials: 'include'` the request goes out unauthenticated and answers
    // 401, which reads as "signed out" on a page that is signed in.
    const { impl, calls } = recording(200, PROFILE)
    await profileApi('https://api.test', impl).read()

    expect(calls[0]?.credentials).toBe('include')
  })

  it('reads a 401 as "not signed in" rather than as a failure', async () => {
    // An ordinary state. Most of this application works without an account.
    const { impl } = recording(401, {})

    expect(await profileApi('https://api.test', impl).read()).toBeUndefined()
  })

  it('reports anything else', async () => {
    const { impl } = recording(500, {})

    await expect(profileApi('https://api.test', impl).read()).rejects.toThrow(/500/)
  })

  it('sends the chosen locale', async () => {
    const { impl, calls } = recording(200, PROFILE)
    await profileApi('https://api.test', impl).update({ locale: 'de' })

    expect(calls[0]?.method).toBe('PUT')
    expect(calls[0]?.body).toBe('{"locale":"de"}')
  })

  it('reports a refused save', async () => {
    const { impl } = recording(400, {})

    await expect(profileApi('https://api.test', impl).update({ locale: 'de' })).rejects.toThrow(
      /could not be saved/,
    )
  })

  it('tolerates a trailing slash on the base URL', async () => {
    const { impl, calls } = recording(200, PROFILE)
    await profileApi('https://api.test/', impl).read()

    expect(calls[0]?.url).toBe('https://api.test/profile')
  })
})
