import { describe, expect, it } from 'vitest'
import { type CachedProfile, localCache, PROFILE_ID } from '../src/local-cache.js'
import { memoryDatabase } from './support/memory-database.js'

const PROFILE: CachedProfile = {
  sub: 'google|1234',
  locale: 'de',
  email: 'ada@example.com',
  name: 'Ada',
  fetchedAt: '2026-08-27T10:00:00.000Z',
}

describe('caching what the server said', () => {
  it('answers "never fetched" before anything has been', async () => {
    // An answer this application acts on — follow the browser's language — rather than a
    // failure. Throwing would make every caller write the same try/catch.
    expect(await localCache(memoryDatabase()).readProfile()).toBeUndefined()
  })

  it('reads back what was written', async () => {
    const cache = localCache(memoryDatabase())
    await cache.writeProfile(PROFILE)

    expect(await cache.readProfile()).toMatchObject(PROFILE)
  })

  it('replaces rather than accumulating', async () => {
    // One user per browser profile. A second document would mean two answers to "what language
    // is this person using".
    const database = memoryDatabase()
    const cache = localCache(database)

    await cache.writeProfile(PROFILE)
    await cache.writeProfile({ ...PROFILE, locale: 'en' })

    expect((await cache.readProfile())?.locale).toBe('en')
    expect((await database.allDocs()).rows).toHaveLength(1)
  })

  it('can be written twice without a conflict', async () => {
    // A cache written from two tabs is ordinary, and a stale `_rev` there would be a conflict
    // over a value both tabs agree about. The revision is re-read rather than remembered.
    const cache = localCache(memoryDatabase())

    await cache.writeProfile(PROFILE)
    await expect(cache.writeProfile({ ...PROFILE, name: 'Ada L' })).resolves.toBeUndefined()
    expect((await cache.readProfile())?.name).toBe('Ada L')
  })

  it('keeps a profile with no locale, which means "follow the browser"', async () => {
    // Absent rather than a default written in. A stored `en` for someone who never chose one
    // is a preference they cannot tell apart from one they set.
    const { locale: _locale, ...withoutLocale } = PROFILE
    const cache = localCache(memoryDatabase())
    await cache.writeProfile(withoutLocale as CachedProfile)

    const read = await cache.readProfile()
    expect(read?.locale).toBeUndefined()
    expect(read?.sub).toBe('google|1234')
  })

  it('reports a database that is broken rather than reporting it as empty', async () => {
    // "Nothing cached" and "the cache is unreadable" are different facts. Reporting the second
    // as the first would silently reset a user's language on a corrupt database.
    const broken = {
      get: async () => {
        throw Object.assign(new Error('disk is gone'), { status: 500 })
      },
    } as unknown as PouchDB.Database

    await expect(localCache(broken).readProfile()).rejects.toThrow(/disk is gone/)
  })
})

describe('signing out', () => {
  it('removes the cache from this browser', async () => {
    // It holds a name and an email address belonging to the person who signed in. Leaving them
    // behind on a shared machine is the reason this is an operation rather than a comment.
    const database = memoryDatabase()
    const cache = localCache(database)
    await cache.writeProfile(PROFILE)

    await cache.clear()

    await expect(database.info()).rejects.toThrow()
  })

  it('leaves no tombstone carrying the id', async () => {
    // `destroy` rather than deleting documents: a deleted document leaves a tombstone that
    // still carries its id, and the point of signing out is that nothing of the previous user
    // remains here.
    const database = memoryDatabase()
    await localCache(database).writeProfile(PROFILE)
    await localCache(database).clear()

    const fresh = memoryDatabase()
    expect((await fresh.allDocs()).rows.map((row) => row.id)).not.toContain(PROFILE_ID)
  })
})

describe('the cache is never replicated', () => {
  it('does not hand back anything that could be', async () => {
    // The structural half, and the stronger one. `LocalCache` exposes reading, writing and
    // clearing and never returns the PouchDB handle — so a caller cannot replicate what it
    // cannot reach, and "nobody synced it" stops being a thing to remember.
    const cache = localCache(memoryDatabase())

    expect(Object.keys(cache).sort()).toEqual(['clear', 'readProfile', 'writeProfile'])
    for (const value of Object.values(cache)) {
      expect(typeof value).toBe('function')
    }
  })

  it('fails if anything reaches for sync or replicate', async () => {
    // The test the issue asks for, on a database that refuses to be replicated. Replicating
    // this would push a cached copy of *server state* back at the server as though it were user
    // data — and pull other people's cached state down.
    const database = memoryDatabase()
    const guarded = new Proxy(database, {
      get(target, property, receiver) {
        if (property === 'sync' || property === 'replicate') {
          throw new Error(`mm-local must never be ${String(property)}ed`)
        }
        return Reflect.get(target, property, receiver)
      },
    })

    const cache = localCache(guarded)
    await cache.writeProfile(PROFILE)

    expect(await cache.readProfile()).toMatchObject(PROFILE)
  })
})
