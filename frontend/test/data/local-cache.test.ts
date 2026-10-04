import { describe, expect, it } from 'vitest'
import { type CachedProfile, localCache, PROFILE_ID } from '../../src/data/local-cache.js'
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

  it('round-trips the plan and the limit', async () => {
    const cache = localCache(memoryDatabase())

    await cache.writeProfile({ ...PROFILE, plan: 'member', projectLimit: 5 })

    expect(await cache.readProfile()).toMatchObject({ plan: 'member', projectLimit: 5 })
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

    // Listed exactly, not counted. Every name here reads or writes plain values; the moment
    // one of them returns the database itself, this fails and says so by name.
    expect(Object.keys(cache).sort()).toEqual([
      'addLocalProject',
      'clear',
      'markAccessRemoved',
      'readLocalProjects',
      'readProfile',
      'readProjects',
      'removeLocalProject',
      'setLocalState',
      'updateLocalProject',
      'writeProfile',
      'writeProjects',
    ])
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

describe('the local project index', () => {
  const entry = (dbName: string, name: string) => ({
    dbName,
    name,
    createdAt: '2026-10-03T09:00:00.000Z',
  })

  it('lists what was added, in name order', async () => {
    const cache = localCache(memoryDatabase())
    await cache.addLocalProject(entry('project_local_b', 'B'))
    await cache.addLocalProject(entry('project_local_a', 'A'))

    expect((await cache.readLocalProjects()).map((e) => e.dbName)).toEqual([
      'project_local_a',
      'project_local_b',
    ])
  })

  it('replaces an entry added twice, and patches, and removes', async () => {
    const cache = localCache(memoryDatabase())
    await cache.addLocalProject(entry('project_local_a', 'A'))
    await cache.addLocalProject(entry('project_local_a', 'A2'))
    await cache.updateLocalProject('project_local_a', { client: 'Acme' })
    expect(await cache.readLocalProjects()).toEqual([
      { ...entry('project_local_a', 'A2'), client: 'Acme' },
    ])

    await cache.removeLocalProject('project_local_a')
    await cache.removeLocalProject('project_local_a')
    expect(await cache.readLocalProjects()).toEqual([])
  })

  it('keeps the role of a downloaded copy, and lets it change', async () => {
    const cache = localCache(memoryDatabase())
    const shared = { ...entry('project_s1', 'S'), projectId: 's1', role: 'write' as const }
    await cache.addLocalProject(shared)
    expect(await cache.readLocalProjects()).toEqual([shared])

    await cache.updateLocalProject('project_s1', { role: 'read' })
    expect(await cache.readLocalProjects()).toEqual([{ ...shared, role: 'read' }])
  })

  it('does not invent an entry when patching one that is not there', async () => {
    const cache = localCache(memoryDatabase())
    await cache.updateLocalProject('project_local_x', { name: 'X' })
    expect(await cache.readLocalProjects()).toEqual([])
  })

  it('keeps the index apart from the profile and the server list', async () => {
    const cache = localCache(memoryDatabase())
    await cache.writeProfile(PROFILE)
    await cache.addLocalProject(entry('project_local_a', 'A'))
    expect(await cache.readProjects()).toEqual([])
    expect(await cache.readProfile()).toMatchObject(PROFILE)
  })
})

/**
 * A real in-memory database with some methods replaced, so a failure can be injected at one
 * call while everything else behaves as PouchDB does.
 */
function withOverrides(
  database: PouchDB.Database,
  overrides: Partial<Record<'get' | 'put' | 'allDocs' | 'bulkDocs', (...args: never[]) => unknown>>,
): PouchDB.Database {
  return new Proxy(database, {
    get(target, property, receiver) {
      const override = (overrides as Record<string | symbol, unknown>)[property]
      if (override !== undefined) return override
      const value = Reflect.get(target, property, receiver)
      return typeof value === 'function' ? value.bind(target) : value
    },
  })
}

const conflict = () => Object.assign(new Error('conflict'), { status: 409, name: 'conflict' })

describe('the local project index under contention and failure', () => {
  const entry = {
    dbName: 'project_local_a',
    name: 'A',
    createdAt: '2026-10-03T09:00:00.000Z',
  }

  /** Fails the first `losses` puts with a revision conflict, then lets writes through. */
  const losingPuts = (database: PouchDB.Database, losses: number, error: Error = conflict()) => {
    let remaining = losses
    let attempts = 0
    const wrapped = withOverrides(database, {
      put: async (...args: never[]) => {
        attempts += 1
        if (remaining > 0) {
          remaining -= 1
          throw error
        }
        return database.put(...(args as unknown as [PouchDB.Core.PutDocument<object>]))
      },
    })
    return { wrapped, attempts: () => attempts }
  }

  it('retries a write that lost the revision race and then lands it', async () => {
    const database = memoryDatabase()
    await localCache(database).addLocalProject(entry)
    const { wrapped, attempts } = losingPuts(database, 2)

    await localCache(wrapped).updateLocalProject(entry.dbName, { name: 'A2' })

    expect(attempts()).toBe(3)
    expect((await localCache(database).readLocalProjects())[0]?.name).toBe('A2')
  })

  it('gives up after three lost races rather than looping', async () => {
    const database = memoryDatabase()
    const { wrapped, attempts } = losingPuts(database, 99)

    await expect(localCache(wrapped).addLocalProject(entry)).rejects.toMatchObject({
      status: 409,
    })
    expect(attempts()).toBe(3)
  })

  it('recognises a conflict by its name when the status is missing', async () => {
    const database = memoryDatabase()
    const { wrapped } = losingPuts(database, 1, Object.assign(new Error('c'), { name: 'conflict' }))

    await localCache(wrapped).addLocalProject(entry)

    expect(await localCache(database).readLocalProjects()).toHaveLength(1)
  })

  it('does not retry a write that failed for another reason', async () => {
    const database = memoryDatabase()
    const { wrapped, attempts } = losingPuts(
      database,
      99,
      Object.assign(new Error('quota'), { status: 500 }),
    )

    await expect(localCache(wrapped).addLocalProject(entry)).rejects.toThrow(/quota/)
    expect(attempts()).toBe(1)
  })

  it('reports an unreadable index rather than overwriting it', async () => {
    const broken = withOverrides(memoryDatabase(), {
      get: async () => {
        throw Object.assign(new Error('disk is gone'), { status: 500 })
      },
    })

    await expect(localCache(broken).removeLocalProject('project_local_a')).rejects.toThrow(
      /disk is gone/,
    )
  })

  it('reports an unreadable profile when writing, rather than overwriting it blind', async () => {
    const broken = withOverrides(memoryDatabase(), {
      get: async () => {
        throw Object.assign(new Error('disk is gone'), { status: 500 })
      },
    })

    await expect(localCache(broken).writeProfile(PROFILE)).rejects.toThrow(/disk is gone/)
  })

  it('skips rows that carry no document, such as ones deleted underneath the listing', async () => {
    const stub = withOverrides(memoryDatabase(), {
      allDocs: async () => ({ total_rows: 2, offset: 0, rows: [{ id: 'x', key: 'x', value: {} }] }),
    })

    expect(await localCache(stub).readLocalProjects()).toEqual([])
    expect(await localCache(stub).readProjects()).toEqual([])
  })

  it('gives up on a project write that keeps losing, and does not retry other failures', async () => {
    const database = memoryDatabase()
    await database.put({
      _id: 'cache:project:p1',
      projectId: 'p1',
      localState: 'not-downloaded',
      accessRemoved: false,
    })

    const losing = losingPuts(database, 99)
    await expect(localCache(losing.wrapped).markAccessRemoved('p1')).rejects.toMatchObject({
      status: 409,
    })
    expect(losing.attempts()).toBe(3)

    const failing = losingPuts(database, 99, Object.assign(new Error('quota'), { status: 500 }))
    await expect(localCache(failing.wrapped).markAccessRemoved('p1')).rejects.toThrow(/quota/)
    expect(failing.attempts()).toBe(1)
  })

  it('throws a refused bulk write at once, and a conflicting one only after three tries', async () => {
    const server = { projectId: 'p1', dbName: 'project_p1', name: 'P', role: 'owner' as const }
    const bulk = (result: unknown) => {
      let calls = 0
      const stub = withOverrides(memoryDatabase(), {
        bulkDocs: async () => {
          calls += 1
          return [result]
        },
      })
      return { stub, calls: () => calls }
    }

    const refused = bulk({ error: true, status: 500, name: 'forbidden' })
    await expect(localCache(refused.stub).writeProjects([server], 'now')).rejects.toMatchObject({
      status: 500,
    })
    expect(refused.calls()).toBe(1)

    const contended = bulk({ error: true, status: 409, name: 'conflict' })
    await expect(localCache(contended.stub).writeProjects([server], 'now')).rejects.toMatchObject({
      status: 409,
    })
    expect(contended.calls()).toBe(3)
  })
})
