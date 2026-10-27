import PouchDB from 'pouchdb-browser'
import { afterEach, describe, expect, it } from 'vitest'
import {
  ARCHIVE_LIMITS,
  ArchiveError,
  projectArchiveEntries,
} from '../../../src/domain/archive/project-archive.js'
import { readZip, writeZip, ZipError } from '../../../src/domain/archive/zip.js'
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

/** Imports bytes the way the picker hands them over: as a file. */
const importBytes = (bytes: Uint8Array, deps?: Parameters<typeof importProjectFile>[1]) =>
  importProjectFile(new Blob([bytes as BlobPart]), deps)

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
    const result = await importBytes(
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
    const result = await importBytes(await zipOf('Hillside', [device('a')]))

    const [stored] = await openProject(result.entry.dbName).devices.list()
    expect(stored?.updatedAt).not.toBe('2026-10-01T08:00:00.000Z')
  })

  it('gives a name that is taken a suffix, so two projects are not called the same', async () => {
    await createLocalProject({ name: 'Hillside' })

    const first = await importBytes(await zipOf('Hillside', [device('a')]))
    const second = await importBytes(await zipOf('Hillside', [device('a')]))

    expect(first.entry.name).toBe('Hillside (imported)')
    expect(second.entry.name).toBe('Hillside (imported 2)')
  })

  it('reports how many devices were filed under Imported', async () => {
    const result = await importBytes(await zipOf('Hillside', [device('a', { room: '' })]))

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
    const result = await importBytes(bytes)

    expect(result.entry.name).toBe('Round trip (imported)')
    const [copied] = await openProject(result.entry.dbName).devices.list()
    expect(copied).toMatchObject({ _id: 'device:a', name: 'Lamp a', spot: 'ceiling' })
  })
})

describe('an encrypted project, out and back in', () => {
  // Review focus 3 of the encryption plan: the archive is plaintext by format, so an unlocked
  // export must carry the codes in the clear, and the import must encrypt them again under the
  // new project's own key — never copy ciphertext across, never store plaintext.
  it('exportImportRoundTripsPlaintext', async () => {
    const PAYLOAD = 'MT:Y.K9042C00KA0648G00'
    const LONG = '749701123365521327687'
    const source = await createLocalProject({ name: 'Encrypted' })
    const {
      _rev: _r,
      updatedAt: _u,
      ...fresh
    } = device('a', { payload: PAYLOAD, manualCode: LONG })
    await openProject(source.dbName).devices.save(fresh)
    // The premise: the source really is encrypted, or the round trip proves nothing.
    const sourceRaw = (await rawDatabase(source.dbName).get('device:a')) as Record<string, unknown>
    expect(sourceRaw.payload).toMatch(/^enc:v1:/)
    let bytes: Uint8Array = new Uint8Array()

    await exportProject(
      { dbName: source.dbName, name: 'Encrypted' },
      {
        devices: (dbName) => openProject(dbName).devices.list(),
        projectDocument: async () => ({ name: 'Encrypted' }),
        now: () => new Date('2026-10-19T15:00:00Z'),
        download: (written) => {
          bytes = written
        },
      },
    )

    // Every file in the archive, as text: the codes are there in the clear, and no ciphertext.
    const files = await readZip(bytes, streamCodecs, ARCHIVE_LIMITS)
    const text = files.map((file) => new TextDecoder().decode(file.data)).join('\n')
    expect(text).toContain(PAYLOAD)
    expect(text).toContain(LONG)
    expect(text).not.toContain('enc:')

    const result = await importBytes(bytes)

    const stored = (await rawDatabase(result.entry.dbName).get('device:a')) as Record<
      string,
      unknown
    >
    expect(stored.payload).toMatch(/^enc:v1:/)
    expect(stored.manualCode).toMatch(/^enc:v1:/)
    // Encrypted afresh under the new project's key, not the source's ciphertext carried over.
    expect(stored.payload).not.toBe(sourceRaw.payload)
    const read = await openProject(result.entry.dbName).devices.get('device:a')
    expect(read?.payload).toBe(PAYLOAD)
    expect(read?.manualCode).toBe(LONG)
  })
})

describe('refusing, and leaving nothing behind', () => {
  it('refuses a file past the size limit without reading it', async () => {
    // A picked file can be any size; reading a large one whole just to refuse it would hold all
    // of it in memory first.
    let read = false
    const huge = {
      size: ARCHIVE_LIMITS.maxBytes + 1,
      arrayBuffer: async () => {
        read = true
        return new ArrayBuffer(0)
      },
    } as unknown as Blob

    const failure = await importProjectFile(huge).catch((error: unknown) => error)

    expect((failure as ZipError).problem).toBe('tooLarge')
    expect(read).toBe(false)
  })

  it('refuses a file that is not a zip, and creates nothing', async () => {
    const failure = await importBytes(new TextEncoder().encode('hello')).catch(
      (error: unknown) => error,
    )

    expect(failure).toBeInstanceOf(ZipError)
    expect(await localProfileCache().readLocalProjects()).toEqual([])
  })

  it('refuses an archive with a bad device before creating anything', async () => {
    const failure = await importBytes(
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

    const failure = await importBytes(
      await zipOf('Hillside', [device('a'), device('b'), device('c')]),
      failing,
    ).catch((error: unknown) => error)

    expect(failure).toBeInstanceOf(Error)
    expect(created).not.toBe('')
    expect(await localProfileCache().readLocalProjects()).toEqual([])
    expect(await documentCount(created)).toBe(0)
  })

  it('destroys the written database when listing it fails', async () => {
    let created = ''
    const cache = localProjectDefaults.cache()
    const failing = {
      ...localProjectDefaults,
      cache: () => ({
        ...cache,
        readLocalProjects: () => cache.readLocalProjects(),
        addLocalProject: async () => Promise.reject(new Error('disk full')),
      }),
      database: (dbName: string) => {
        created = dbName
        return localProjectDefaults.database(dbName)
      },
    }

    const failure = await importBytes(
      await zipOf('Hillside', [device('a'), device('b')]),
      failing,
    ).catch((error: unknown) => error)

    expect(failure).toBeInstanceOf(Error)
    expect(created).not.toBe('')
    expect(await documentCount(created)).toBe(0)
  })
})
