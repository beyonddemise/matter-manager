import { beforeEach, describe, expect, it } from 'vitest'
import { type LocalCache, localCache, type ServerProject } from '../src/index.js'
import { memoryDatabase } from './support/memory-database.js'

/**
 * `mm-local`, extended from the profile to the project list (M5-7).
 *
 * The whole of this file turns on one distinction: **the server says what you may access, and
 * this device says what it actually holds.** They are written by different things at different
 * times and they diverge constantly — a project granted on a phone is not downloaded on a
 * laptop — so the tests that matter most here are the ones where one half is rewritten and the
 * other has to survive it.
 */

const HOUSE: ServerProject = {
  projectId: 'p-house',
  dbName: 'project_p-house',
  name: 'Lindenstraße 4',
  role: 'owner',
}

const FLAT: ServerProject = {
  projectId: 'p-flat',
  dbName: 'project_p-flat',
  name: 'Ferienwohnung',
  role: 'read',
}

const FETCHED = '2026-08-20T08:00:00.000Z'
const LATER = '2026-08-20T09:00:00.000Z'

let cache: LocalCache

beforeEach(() => {
  cache = localCache(memoryDatabase())
})

describe('the project list survives going offline', () => {
  it('is empty before the server has ever been reached', async () => {
    // Not an error and not a failure to load. A browser that has never been online has an
    // empty list, which is a true answer the interface can show.
    expect(await cache.readProjects()).toEqual([])
  })

  it('reads back what the server said', async () => {
    await cache.writeProjects([HOUSE, FLAT], FETCHED)

    expect(await cache.readProjects()).toEqual([
      { ...FLAT, localState: 'not-downloaded', accessRemoved: false, fetchedAt: FETCHED },
      { ...HOUSE, localState: 'not-downloaded', accessRemoved: false, fetchedAt: FETCHED },
    ])
  })

  it('starts every project as not-downloaded', async () => {
    // Appearing in the server's list says the user *may* open it, which is not the same as
    // having it. Assuming otherwise would offer a project that opens to nothing.
    await cache.writeProjects([HOUSE], FETCHED)

    expect((await cache.readProjects())[0]?.localState).toBe('not-downloaded')
  })
})

describe('what I may access and what I have are tracked separately', () => {
  it('records that a replica is now on this device', async () => {
    await cache.writeProjects([HOUSE, FLAT], FETCHED)
    await cache.setLocalState(HOUSE.projectId, 'downloaded')

    const projects = await cache.readProjects()
    expect(projects.find((p) => p.projectId === HOUSE.projectId)?.localState).toBe('downloaded')
    expect(projects.find((p) => p.projectId === FLAT.projectId)?.localState).toBe('not-downloaded')
  })

  it('keeps that record when the server list is fetched again', async () => {
    // **The invariant this whole design exists for.** The list is re-fetched on every
    // reconnection, and a refresh that reset `localState` would report every project as not
    // downloaded moments after connectivity returned — on precisely the devices that do hold
    // them, and with no way for the user to tell it was wrong.
    await cache.writeProjects([HOUSE, FLAT], FETCHED)
    await cache.setLocalState(HOUSE.projectId, 'downloaded')

    await cache.writeProjects([HOUSE, FLAT], LATER)

    const projects = await cache.readProjects()
    expect(projects.find((p) => p.projectId === HOUSE.projectId)?.localState).toBe('downloaded')
    expect(projects.every((p) => p.fetchedAt === LATER)).toBe(true)
  })

  it('takes the server half of a project from the server, every time', async () => {
    // The other direction of the same rule: a rename on somebody else's device has to arrive.
    await cache.writeProjects([HOUSE], FETCHED)
    await cache.setLocalState(HOUSE.projectId, 'downloaded')

    await cache.writeProjects([{ ...HOUSE, name: 'Lindenstraße 4a', role: 'read' }], LATER)

    const [project] = await cache.readProjects()
    expect(project?.name).toBe('Lindenstraße 4a')
    expect(project?.role).toBe('read')
    expect(project?.localState).toBe('downloaded')
  })

  it('forgets a project this device never downloaded once access goes', async () => {
    await cache.writeProjects([HOUSE, FLAT], FETCHED)

    await cache.writeProjects([HOUSE], LATER)

    // Nothing of it is here and the user may no longer open it, so listing it would offer a
    // door that does not open.
    expect((await cache.readProjects()).map((p) => p.projectId)).toEqual([HOUSE.projectId])
  })
})

describe('revoked access is reported, not hidden', () => {
  it('keeps a downloaded project and marks it, rather than dropping it', async () => {
    await cache.writeProjects([HOUSE, FLAT], FETCHED)
    await cache.setLocalState(FLAT.projectId, 'downloaded')

    await cache.writeProjects([HOUSE], LATER)

    // The data is still on this device — M5-3 requires the user be told plainly that it
    // remains — so removing the entry would make a copy they still hold invisible and
    // unexplained, which reads as the application having lost it.
    const flat = (await cache.readProjects()).find((p) => p.projectId === FLAT.projectId)
    expect(flat?.accessRemoved).toBe(true)
    expect(flat?.localState).toBe('downloaded')
  })

  it('marks a project whose replication was refused', async () => {
    // The offline case: access was revoked while this browser could not hear about it, and the
    // first news is a 403 from replication rather than an absence from the list.
    await cache.writeProjects([HOUSE], FETCHED)
    await cache.setLocalState(HOUSE.projectId, 'downloaded')

    await cache.markAccessRemoved(HOUSE.projectId)

    expect((await cache.readProjects())[0]?.accessRemoved).toBe(true)
  })

  it('forgets a revoked project when its replica is removed', async () => {
    await cache.writeProjects([HOUSE], FETCHED)
    await cache.setLocalState(HOUSE.projectId, 'downloaded')
    await cache.markAccessRemoved(HOUSE.projectId)

    await cache.setLocalState(HOUSE.projectId, 'not-downloaded')

    expect(await cache.readProjects()).toEqual([])
  })

  it('clears the mark when access comes back', async () => {
    // Being re-granted is ordinary — a mistake corrected, a role changed twice. A mark that
    // only ever went on would leave the project permanently labelled as lost.
    await cache.writeProjects([HOUSE], FETCHED)
    await cache.markAccessRemoved(HOUSE.projectId)

    await cache.writeProjects([HOUSE], LATER)

    expect((await cache.readProjects())[0]?.accessRemoved).toBe(false)
  })

  it('raises a cache that cannot be read, rather than doing nothing', async () => {
    // "Not there" is an answer this application acts on; "the database is broken" is not the
    // same thing. Swallowing both would turn an unreadable cache into a device that silently
    // stops recording what it has downloaded — and then reports every project as unavailable
    // offline, with nothing anywhere saying why.
    const broken = new Proxy(memoryDatabase(), {
      get(target, property, receiver) {
        if (property === 'get') {
          return async () => {
            throw Object.assign(new Error('database is not open'), { status: 500 })
          }
        }
        const value = Reflect.get(target, property, receiver) as unknown
        return typeof value === 'function' ? value.bind(target) : value
      },
    }) as PouchDB.Database

    await expect(localCache(broken).setLocalState('p-house', 'downloaded')).rejects.toThrow(
      'database is not open',
    )
  })

  it('says nothing about a project it has never heard of', async () => {
    // A 403 for something not in the cache is not a reason to invent an entry: there is no
    // name to show and nothing on this device to explain.
    await cache.markAccessRemoved('p-unknown')

    expect(await cache.readProjects()).toEqual([])
  })

  it.each([
    ['the replica is recorded first', true],
    ['the refusal is recorded first', false],
  ])('keeps both local changes when two tabs amend: %s', async (_description, stateFirst) => {
    await cache.writeProjects([HOUSE], FETCHED)

    const recordState = () => cache.setLocalState(HOUSE.projectId, 'downloaded')
    const recordRefusal = () => cache.markAccessRemoved(HOUSE.projectId)
    await Promise.all(stateFirst ? [recordState(), recordRefusal()] : [recordRefusal(), recordState()])

    expect((await cache.readProjects())[0]).toMatchObject({
      localState: 'downloaded',
      accessRemoved: true,
    })
  })
})

describe('the cache is still a cache', () => {
  it('is emptied by signing out', async () => {
    await cache.writeProjects([HOUSE, FLAT], FETCHED)
    await cache.writeProfile({ sub: 'google|1', fetchedAt: FETCHED })

    await cache.clear()

    // The project names are a signed-in user's, and a shared machine is the reason this is an
    // operation rather than a comment.
    const fresh = localCache(memoryDatabase())
    expect(await fresh.readProjects()).toEqual([])
  })

  it('leaves the profile alone when the project list is written', async () => {
    // One database, two unrelated things in it. A project refresh that disturbed the profile
    // would log the user out on every reconnection.
    await cache.writeProfile({ sub: 'google|1', name: 'Anna', fetchedAt: FETCHED })
    await cache.writeProjects([HOUSE], LATER)

    expect(await cache.readProfile()).toMatchObject({ sub: 'google|1', name: 'Anna' })
  })

  it('survives the same list being written twice from two tabs', async () => {
    // Two tabs both reconnecting is ordinary, and a stale `_rev` there is a conflict over a
    // value both tabs agree about.
    await cache.writeProjects([HOUSE], FETCHED)

    await Promise.all([cache.writeProjects([HOUSE], LATER), cache.writeProjects([HOUSE], LATER)])

    expect(await cache.readProjects()).toHaveLength(1)
  })
})
