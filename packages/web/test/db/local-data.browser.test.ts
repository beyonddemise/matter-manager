import PouchDB from 'pouchdb-browser'
import { afterEach, describe, expect, it } from 'vitest'
import {
  LOCAL_CACHE_DATABASE_NAME,
  localProfileCache,
  PROJECT_DATABASE_NAME,
  projectDatabase,
  removeLocalDatabases,
} from '../../src/db/project-database.js'

/** A device, with the fields the repository requires and nothing this test cares about. */
const device = (id: string, name: string) => ({
  _id: id,
  type: 'device' as const,
  name,
  roomId: 'room:kitchen',
  manualCode: '34970112332',
  installedAt: '2026-08-26',
  addedAt: '2026-08-26T09:00:00.000Z',
  disabled: false,
  remarks: [],
})

/** How many documents a database holds, opened fresh so no memoised handle can answer. */
async function documentCount(name: string): Promise<number> {
  const database = new PouchDB(name)
  try {
    return (await database.info()).doc_count
  } finally {
    await database.close()
  }
}

afterEach(async () => {
  await removeLocalDatabases({ includeLocalCatalogue: true }).catch(() => undefined)
})

describe('removing everything this browser holds', () => {
  it('removes the devices', async () => {
    // The first scenario, and the obvious half: what the user put in is gone.
    await projectDatabase().devices.save(device('device:lamp', 'Kitchen lamp'))
    expect(await documentCount(PROJECT_DATABASE_NAME)).toBeGreaterThan(0)

    await removeLocalDatabases({ includeLocalCatalogue: true })

    expect(await documentCount(PROJECT_DATABASE_NAME)).toBe(0)
  })

  it('keeps the local catalogue unless the reader asked for it to go', async () => {
    // #55. The catalogue on this device predates accounts and holds whatever was recorded
    // before signing in, so signing out of an unrelated account must not take it. The sign-out
    // control asks; this is what the default answer means.
    await projectDatabase().devices.save(device('device:hall', 'Hall light'))

    await removeLocalDatabases()

    expect(await documentCount(PROJECT_DATABASE_NAME)).toBeGreaterThan(0)
  })

  it('removes a replicated project database', async () => {
    // #120 gave this browser a database per project the account can see, and nothing removed
    // them - so signing out left every device of the previous user on a shared machine, which
    // is the one thing signing out exists to prevent.
    const replicated: string[] = []
    await localProfileCache().writeProjects(
      [
        {
          projectId: 'p1',
          dbName: 'project_p1',
          name: 'Musterstraße 12',
          role: 'owner',
        },
      ],
      '2026-08-31T09:00:00.000Z',
    )

    await removeLocalDatabases({}, async (name) => {
      replicated.push(name)
    })

    expect(replicated).toContain('project_p1')
  })

  it('removes the cached profile too', async () => {
    // The less obvious half. A sign-out that leaves `mm-local` behind leaves the previous
    // user's name and locale on a shared machine — the thing signing out is *for*.
    await localProfileCache().writeProfile({
      sub: 'google|1234',
      name: 'Ada',
      locale: 'de',
      fetchedAt: '2026-08-26T09:00:00.000Z',
    })
    expect(await documentCount(LOCAL_CACHE_DATABASE_NAME)).toBeGreaterThan(0)

    await removeLocalDatabases()

    expect(await documentCount(LOCAL_CACHE_DATABASE_NAME)).toBe(0)
  })

  it('removes a database this session never opened', async () => {
    // **The one that is easy to get wrong.** Destroying only the memoised handles removes what
    // this page happens to have touched. A user who reloads and signs out from the settings page
    // without ever visiting the device list would keep every device on disk, and the interface
    // would say they had signed out.
    const untouched = new PouchDB(PROJECT_DATABASE_NAME)
    await untouched.put({ _id: 'device:left-behind' })
    await untouched.close()

    await removeLocalDatabases({ includeLocalCatalogue: true })

    expect(await documentCount(PROJECT_DATABASE_NAME)).toBe(0)
  })

  it('leaves the next open working rather than handing back a destroyed handle', async () => {
    // A destroyed PouchDB handle does not come back: a later read through the same object fails
    // rather than finding an empty database. Signing out and signing in again in one page load
    // is ordinary, so the memoised handles have to go with the data.
    await projectDatabase().devices.save(device('device:sensor', 'Hall sensor'))

    await removeLocalDatabases({ includeLocalCatalogue: true })

    await expect(projectDatabase().devices.list()).resolves.toEqual([])
  })

  it('attempts both even when one of them fails', async () => {
    // Sequential awaits would stop at the first failure and leave the second database intact,
    // which is the "signed out but the data is still here" state.
    const attempted: string[] = []
    const failing = async (name: string) => {
      attempted.push(name)
      throw new Error(`storage refused ${name}`)
    }

    await expect(removeLocalDatabases({ includeLocalCatalogue: true }, failing)).rejects.toThrow()
    expect(attempted).toEqual([LOCAL_CACHE_DATABASE_NAME, PROJECT_DATABASE_NAME])
  })

  it('reports a failure rather than returning quietly', async () => {
    // `signOut` turns this into "we could not remove everything". It can only do that if it is
    // told, and a silent success here is a sign-out that says it worked on a machine still
    // holding the data.
    await expect(
      removeLocalDatabases({}, async () => {
        throw new Error('storage refused')
      }),
    ).rejects.toThrow()
  })

  it('forgets the handles even when the destroy fails', async () => {
    // Otherwise a retry works through a handle pointing at a database that may be half gone.
    await projectDatabase().devices.save(device('device:porch', 'Porch light'))

    await removeLocalDatabases({ includeLocalCatalogue: true }, async () => {
      throw new Error('storage refused')
    }).catch(() => undefined)

    await expect(projectDatabase().devices.list()).resolves.toHaveLength(1)
  })
})
