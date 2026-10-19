import PouchDB from 'pouchdb-browser'
import { afterEach, describe, expect, it } from 'vitest'
import { ArchiveError, projectArchiveEntries } from '../../../src/domain/archive/project-archive.js'
import { writeZip, ZipError } from '../../../src/domain/archive/zip.js'
import { PROJECT_DOCUMENT_ID } from '../../../src/domain/documents/project.js'
import type { DeviceDocument } from '../../../src/domain/index.js'
import { streamCodecs } from '../../../src/ui/archive/codec.js'
import { exportProject } from '../../../src/ui/archive/project-export.js'
import { importProjectFile } from '../../../src/ui/archive/project-import.js'
import {
  localProfileCache,
  openProject,
  rawDatabase,
  removeLocalDatabases,
} from '../../../src/ui/db/project-database.js'
import { createLocalProject, localProjectDefaults } from '../../../src/ui/local-projects.js'

/**
 * Importing a project export: always a new local-only project, written in the order
 * `createLocalProject` uses - database and devices first, the index entry last - so a failure
 * part-way leaves nothing listed and nothing behind.
 */

const MANUAL = '34970112332'

const device = (uuid: string, extra: Partial<DeviceDocument> = {}): DeviceDocument => ({
  _id: `device:${uuid}`,
  _rev: '1-a',
  updatedAt: '2026-10-01T08:00:00.000Z',
  type: 'device',
  name: `Lamp ${uuid}`,
  room: 'Ground Floor/Kitchen',
  manualCode: MANUAL,
  installedAt: '2026-08-19',
  addedAt: '2026-08-19T08:00:00.000Z',
  disabled: false,
  remarks: [],
  ...extra,
})

const zipOf = (name: string, devices: readonly DeviceDocument[], client?: string) =>
  writeZip(
    projectArchiveEntries(
      { name, ...(client === undefined ? {} : { client }) },
      devices,
      '2026-10-19T15:00:00.000Z',
    ),
    streamCodecs,
    new Date('2026-10-19T15:00:00Z'),
  )

/** How many documents a database holds, opened fresh so no memoised handle answers. */
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

describe('importing a project export', () => {
  it('creates a new local project holding the devices, and lists it', async () => {
    const result = await importProjectFile(
      await zipOf('Hillside', [device('a'), device('b')], 'Ms Example'),
    )

    expect(result.devices).toBe(2)
    expect(result.refiled).toBe(0)
    expect(result.entry.dbName).toMatch(/^project_local_/)
    expect(result.entry.name).toBe('Hillside')
    expect(await rawDatabase(result.entry.dbName).get(PROJECT_DOCUMENT_ID)).toMatchObject({
      name: 'Hillside',
      client: 'Ms Example',
    })
    const devices = await openProject(result.entry.dbName).devices.list()
    expect(devices.map((d) => d.name).sort()).toEqual(['Lamp a', 'Lamp b'])
    expect(await localProfileCache().readLocalProjects()).toEqual([result.entry])
  })

  it('stamps the devices as written now, not with the stamp in the file', async () => {
    const result = await importProjectFile(await zipOf('Hillside', [device('a')]))

    const [stored] = await openProject(result.entry.dbName).devices.list()
    expect(stored?.updatedAt).not.toBe('2026-10-01T08:00:00.000Z')
  })

  it('gives a name that is taken a suffix, so two projects are not called the same', async () => {
    await createLocalProject({ name: 'Hillside' })

    const first = await importProjectFile(await zipOf('Hillside', [device('a')]))
    const second = await importProjectFile(await zipOf('Hillside', [device('a')]))

    expect(first.entry.name).toBe('Hillside (imported)')
    expect(second.entry.name).toBe('Hillside (imported 2)')
  })

  it('reports how many devices were filed under Imported', async () => {
    const result = await importProjectFile(await zipOf('Hillside', [device('a', { room: '' })]))

    expect(result.refiled).toBe(1)
  })

  it('reads back what an export wrote', async () => {
    const source = await createLocalProject({ name: 'Round trip', client: 'Acme' })
    // Without `_rev`: in a new database it is a first write, and a `_rev` would make it an
    // update of a document that is not there.
    const { _rev: _r, updatedAt: _u, ...fresh } = device('a', { spot: 'ceiling' })
    await openProject(source.dbName).devices.save(fresh)
    let bytes: Uint8Array = new Uint8Array()

    await exportProject(
      { dbName: source.dbName, name: 'Round trip' },
      {
        devices: (dbName) => openProject(dbName).devices.list(),
        projectDocument: async () => ({ name: 'Round trip', client: 'Acme' }),
        now: () => new Date('2026-10-19T15:00:00Z'),
        download: (written) => {
          bytes = written
        },
      },
    )
    const result = await importProjectFile(bytes)

    expect(result.entry.name).toBe('Round trip (imported)')
    const [copied] = await openProject(result.entry.dbName).devices.list()
    expect(copied).toMatchObject({ _id: 'device:a', name: 'Lamp a', spot: 'ceiling' })
  })
})

describe('refusing, and leaving nothing behind', () => {
  it('refuses a file that is not a zip, and creates nothing', async () => {
    const failure = await importProjectFile(new TextEncoder().encode('hello')).catch(
      (error: unknown) => error,
    )

    expect(failure).toBeInstanceOf(ZipError)
    expect(await localProfileCache().readLocalProjects()).toEqual([])
  })

  it('refuses an archive with a bad device before creating anything', async () => {
    const failure = await importProjectFile(
      await zipOf('Hillside', [device('a'), device('b', { name: '' })]),
    ).catch((error: unknown) => error)

    expect(failure).toBeInstanceOf(ArchiveError)
    expect(await localProfileCache().readLocalProjects()).toEqual([])
  })

  it('destroys the half-written database when a write fails, and lists nothing', async () => {
    let created = ''
    let puts = 0
    const failing = {
      ...localProjectDefaults,
      database: (dbName: string) => {
        created = dbName
        const database = rawDatabase(dbName)
        const put = database.put.bind(database)
        // The project document, then one device, then a failure.
        database.put = ((document: object) => {
          puts += 1
          if (puts === 3) return Promise.reject(new Error('disk full'))
          return put(document as PouchDB.Core.PutDocument<object>)
        }) as typeof database.put
        return database
      },
    }

    const failure = await importProjectFile(
      await zipOf('Hillside', [device('a'), device('b'), device('c')]),
      failing,
    ).catch((error: unknown) => error)

    expect(failure).toBeInstanceOf(Error)
    expect(created).not.toBe('')
    expect(await localProfileCache().readLocalProjects()).toEqual([])
    expect(await documentCount(created)).toBe(0)
  })
})
