import PouchDB from 'pouchdb-browser'
import { afterEach, describe, expect, it } from 'vitest'
import { PROJECT_DOCUMENT_ID } from '../../src/domain/documents/project.js'
import {
  localDatabase,
  localProfileCache,
  PROJECT_DATABASE_NAME,
  projectDatabase,
  rawDatabase,
  removeLocalDatabases,
} from '../../src/ui/db/project-database.js'
import {
  adoptLegacyCatalogue,
  createLocalProject,
  destroyLocalProject,
  renameLocalProject,
  setLocalClient,
} from '../../src/ui/local-projects.js'

/** Whether a database holds any document, opened fresh so no memoised handle can answer. */
async function documentCount(name: string): Promise<number> {
  const database = new PouchDB(name)
  try {
    return (await database.info()).doc_count
  } finally {
    await database.close()
  }
}

const device = (id: string) => ({
  _id: id,
  type: 'device' as const,
  name: 'Kitchen lamp',
  roomId: 'room:kitchen',
  manualCode: '34970112332',
  installedAt: '2026-08-26',
  addedAt: '2026-08-26T09:00:00.000Z',
  disabled: false,
  remarks: [],
})

afterEach(async () => {
  await removeLocalDatabases({ includeLocalCatalogue: true }).catch(() => undefined)
})

describe('local projects', () => {
  it('creates a database with a project document and an index entry', async () => {
    const entry = await createLocalProject({ name: 'Musterstraße 12', client: 'Acme' })

    expect(entry.dbName).toMatch(/^project_local_[0-9a-f-]{36}$/)
    expect(await rawDatabase(entry.dbName).get(PROJECT_DOCUMENT_ID)).toMatchObject({
      type: 'project',
      name: 'Musterstraße 12',
      client: 'Acme',
    })
    expect(await localProfileCache().readLocalProjects()).toEqual([entry])
  })

  it('renames and sets the client in both places', async () => {
    const { dbName } = await createLocalProject({ name: 'Old' })

    await renameLocalProject(dbName, 'New')
    await setLocalClient(dbName, 'Acme')
    expect(await rawDatabase(dbName).get(PROJECT_DOCUMENT_ID)).toMatchObject({
      name: 'New',
      client: 'Acme',
    })
    expect(await localProfileCache().readLocalProjects()).toMatchObject([
      { dbName, name: 'New', client: 'Acme' },
    ])

    await setLocalClient(dbName, undefined)
    const document = await rawDatabase(dbName).get(PROJECT_DOCUMENT_ID)
    expect('client' in document).toBe(false)
    expect((await localProfileCache().readLocalProjects())[0]).not.toHaveProperty('client')
  })

  it('destroys the database, the handle and the entry', async () => {
    const { dbName } = await createLocalProject({ name: 'Doomed' })

    await destroyLocalProject(dbName)

    expect(await localProfileCache().readLocalProjects()).toEqual([])
    expect(await documentCount(dbName)).toBe(0)
    // A fresh handle, not a destroyed one.
    await expect(rawDatabase(dbName).info()).resolves.toMatchObject({ doc_count: 0 })
  })
})

describe('adopting the legacy catalogue', () => {
  it('names it and indexes it without touching its devices', async () => {
    await projectDatabase().devices.save(device('device:lamp'))

    await adoptLegacyCatalogue('My home')

    expect(await localProfileCache().readLocalProjects()).toMatchObject([
      { dbName: PROJECT_DATABASE_NAME, name: 'My home' },
    ])
    expect(await projectDatabase().devices.list()).toHaveLength(1)
    expect(await rawDatabase(PROJECT_DATABASE_NAME).get(PROJECT_DOCUMENT_ID)).toMatchObject({
      name: 'My home',
    })
  })

  it('is idempotent and never renames', async () => {
    await projectDatabase().devices.save(device('device:lamp'))
    await adoptLegacyCatalogue('First')
    await adoptLegacyCatalogue('Second')

    expect(await localProfileCache().readLocalProjects()).toMatchObject([{ name: 'First' }])
    expect(await rawDatabase(PROJECT_DATABASE_NAME).get(PROJECT_DOCUMENT_ID)).toMatchObject({
      name: 'First',
    })
  })
})

describe('adopting on a device with nothing to adopt', () => {
  it('creates and indexes nothing', async () => {
    await adoptLegacyCatalogue('Phantom')

    expect(await localProfileCache().readLocalProjects()).toEqual([])
    expect(await documentCount(PROJECT_DATABASE_NAME)).toBe(0)
  })

  it('overwrites a malformed project document instead of failing with a conflict', async () => {
    await rawDatabase(PROJECT_DATABASE_NAME).put({ _id: PROJECT_DOCUMENT_ID, type: 'oops' })

    await adoptLegacyCatalogue('Repaired')

    expect(await rawDatabase(PROJECT_DATABASE_NAME).get(PROJECT_DOCUMENT_ID)).toMatchObject({
      type: 'project',
      name: 'Repaired',
    })
  })
})

describe('signing out with indexed local projects', () => {
  it('destroys indexed databases that were never opened', async () => {
    // Created in a handle of its own, as a previous page load would have left it.
    const dbName = 'project_local_00000000-0000-4000-8000-000000000001'
    const untouched = new PouchDB(dbName)
    await untouched.put({ _id: 'device:left-behind' })
    await untouched.close()
    await localProfileCache().addLocalProject({ dbName, name: 'Left', createdAt: 'x' })

    await removeLocalDatabases({ includeLocalCatalogue: true })

    expect(await documentCount(dbName)).toBe(0)
    expect(await localProfileCache().readLocalProjects()).toEqual([])
  })

  it('keeps indexed local-only projects, and their listing, unless asked', async () => {
    const dbName = 'project_local_00000000-0000-4000-8000-000000000002'
    const untouched = new PouchDB(dbName)
    await untouched.put({ _id: 'device:mine' })
    await untouched.close()
    await localProfileCache().addLocalProject({ dbName, name: 'Mine', createdAt: 'x' })

    await removeLocalDatabases()

    expect(await documentCount(dbName)).toBe(1)
    expect(await localProfileCache().readLocalProjects()).toMatchObject([{ dbName }])
  })

  it('keeps an opened local-only project even when the cache cannot be read', async () => {
    // Without the index, the opened-handle fallback must not mistake local-only data for
    // account data.
    const { dbName } = await createLocalProject({ name: 'Mine' })
    await localDatabase().close()
    const destroyed: string[] = []

    await removeLocalDatabases({}, async (name) => {
      destroyed.push(name)
    })

    expect(destroyed).not.toContain(dbName)
  })

  it('always destroys a downloaded server copy', async () => {
    const dbName = 'project_p9'
    const copy = new PouchDB(dbName)
    await copy.put({ _id: 'device:theirs' })
    await copy.close()
    await localProfileCache().addLocalProject({
      dbName,
      name: 'Shared',
      projectId: 'p9',
      createdAt: 'x',
    })

    await removeLocalDatabases()

    expect(await documentCount(dbName)).toBe(0)
  })
})
