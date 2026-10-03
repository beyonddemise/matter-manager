import { beforeEach, describe, expect, it } from 'vitest'
import { type LocalCache, localCache } from '../../src/data/index.js'
import { fetchProjectList, readProjectFacts } from '../../src/ui/project-inputs.js'
import type { Project } from '../../src/ui/projects.js'
import { memoryDatabase } from '../data/support/memory-database.js'

/**
 * What the shell hands the projects page: the index, the server list (fresh, or the last one
 * heard), and the cached plan. Ruling C-R5: a list that cannot be fetched is replaced by the
 * last one heard, flagged stale, so an offline page still knows counts, roles and archives.
 */

const FETCHED = '2026-10-03T08:00:00.000Z'

const project = (over: Partial<Project> = {}): Project => ({
  projectId: 'p1',
  dbName: 'project_p1',
  name: 'Musterstraße 12',
  client: 'Acme',
  role: 'owner',
  owner: { ownerType: 'user', ownerId: 'u1' },
  archived: false,
  ...over,
})

const entry = {
  dbName: 'project_local_a',
  name: 'Alpha',
  createdAt: '2026-10-01T00:00:00.000Z',
}

let cache: LocalCache

beforeEach(() => {
  cache = localCache(memoryDatabase())
})

describe('the server list', () => {
  it('is returned and remembered when it can be fetched', async () => {
    const listed = [project(), project({ projectId: 'p2', dbName: 'project_p2', archived: true })]

    const fresh = await fetchProjectList(
      async () => listed,
      cache,
      () => FETCHED,
    )

    expect(fresh).toEqual(listed)
    // Remembered with what an offline page needs: the archive and the client.
    const facts = await readProjectFacts(cache, undefined)
    expect(facts.server).toEqual([
      {
        projectId: 'p1',
        dbName: 'project_p1',
        name: 'Musterstraße 12',
        client: 'Acme',
        role: 'owner',
        archived: false,
      },
      {
        projectId: 'p2',
        dbName: 'project_p2',
        name: 'Musterstraße 12',
        client: 'Acme',
        role: 'owner',
        archived: true,
      },
    ])
  })

  it('is undefined when the request fails, and the remembered one survives', async () => {
    await fetchProjectList(
      async () => [project()],
      cache,
      () => FETCHED,
    )

    const fresh = await fetchProjectList(
      async () => {
        throw new TypeError('Failed to fetch')
      },
      cache,
      () => FETCHED,
    )

    expect(fresh).toBeUndefined()
    expect((await readProjectFacts(cache, undefined)).server).toHaveLength(1)
  })

  it('forgets a client the server has cleared', async () => {
    await fetchProjectList(
      async () => [project()],
      cache,
      () => FETCHED,
    )
    const { client: _cleared, ...withoutClient } = project()
    await fetchProjectList(
      async () => [withoutClient],
      cache,
      () => FETCHED,
    )

    const [remembered] = (await readProjectFacts(cache, undefined)).server ?? []
    expect(remembered !== undefined && 'client' in remembered).toBe(false)
  })
})

describe('the facts the page is computed from', () => {
  it('uses a fresh list as it is', async () => {
    const fresh = [project()]
    const facts = await readProjectFacts(cache, fresh)
    expect(facts.server).toBe(fresh)
    expect(facts.serverStale).toBe(false)
  })

  it('falls back to the last list heard, flagged stale', async () => {
    await fetchProjectList(
      async () => [project()],
      cache,
      () => FETCHED,
    )
    const facts = await readProjectFacts(cache, undefined)
    expect(facts.server?.map((p) => p.projectId)).toEqual(['p1'])
    expect(facts.serverStale).toBe(true)
  })

  it('has no list at all when none was ever heard', async () => {
    const facts = await readProjectFacts(cache, undefined)
    expect(facts.server).toBeUndefined()
    expect(facts.serverStale).toBe(true)
  })

  it('reads the local index', async () => {
    await cache.addLocalProject(entry)
    expect((await readProjectFacts(cache, undefined)).local).toEqual([entry])
  })

  it('takes the plan, the limit and the email from the cached profile', async () => {
    await cache.writeProfile({
      sub: 'google|1',
      email: 'ada@example.org',
      plan: 'member',
      projectLimit: 7,
      fetchedAt: FETCHED,
    })
    const facts = await readProjectFacts(cache, undefined)
    expect(facts).toMatchObject({ plan: 'member', reportedLimit: 7, email: 'ada@example.org' })
  })

  it('reads a device that never signed in as free, with no limit heard and no email', async () => {
    const facts = await readProjectFacts(cache, undefined)
    expect(facts.plan).toBe('free')
    expect(facts.reportedLimit).toBeUndefined()
    expect(facts.email).toBeUndefined()
  })

  it('still answers when the cache cannot be read', async () => {
    // An unreadable `mm-local` must not take the page with it: the defaults are a signed-out
    // device with nothing indexed, which the page can render.
    const broken = new Proxy(cache, {
      get: () => async () => {
        throw new Error('unreadable')
      },
    })
    const facts = await readProjectFacts(broken, undefined)
    expect(facts).toEqual({ local: [], server: undefined, serverStale: true, plan: 'free' })
  })
})
