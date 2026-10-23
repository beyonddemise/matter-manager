import { describe, expect, it } from 'vitest'
import { ARCHIVE_LIMITS, readProjectArchive } from '../../../src/domain/archive/project-archive.js'
import { readZip, type ZipEntry, ZipError } from '../../../src/domain/archive/zip.js'
import type { DeviceDocument } from '../../../src/domain/index.js'
import { streamCodecs } from '../../../src/ui/archive/codec.js'
import {
  type ExportDependencies,
  exportFilename,
  exportProject,
  projectDocumentIn,
} from '../../../src/ui/archive/project-export.js'

/**
 * Exporting one project's copy on this device, with every outward reach faked: the database
 * reads, the clock and the download. That the bytes really land in a file the import reads back
 * through real databases is `project-import.browser.test.ts`.
 */

/** A moment by its local wall clock, so the expected date holds in every time zone. */
const at = (hour: number, minute = 0): Date => new Date(2026, 9, 19, hour, minute)

describe('the file name', () => {
  it('is the project name, then the local date', () => {
    expect(exportFilename('Hillside', at(12))).toBe('Hillside 2026-10-19.zip')
  })

  it('takes the local date, not the UTC one, late and early in the day', () => {
    // `toISOString` alone would give the UTC date, a day off for anyone far from Greenwich.
    expect(exportFilename('Hillside', at(23, 59))).toBe('Hillside 2026-10-19.zip')
    expect(exportFilename('Hillside', at(0, 1))).toBe('Hillside 2026-10-19.zip')
  })

  it('replaces each character a file system refuses, keeping the name readable', () => {
    expect(exportFilename('A/B\\C:D*E?F"G<H>I|J', at(12))).toBe(
      'A-B-C-D-E-F-G-H-I-J 2026-10-19.zip',
    )
  })

  it('collapses runs of white space and trims the ends', () => {
    expect(exportFilename('  Musterstraße \t 12  ', at(12))).toBe('Musterstraße 12 2026-10-19.zip')
  })

  it.each(['', '   '])('falls back to "project" when nothing is left (%j)', (name) => {
    expect(exportFilename(name, at(12))).toBe('project 2026-10-19.zip')
  })
})

const device = (uuid: string, extra: Partial<DeviceDocument> = {}): DeviceDocument => ({
  _id: `device:${uuid}`,
  _rev: '3-abc',
  updatedAt: '2026-10-01T08:00:00.000Z',
  type: 'device',
  name: `Lamp ${uuid}`,
  room: 'Ground Floor/Kitchen',
  manualCode: '34970112332',
  installedAt: '2026-08-19',
  addedAt: '2026-08-19T08:00:00.000Z',
  disabled: false,
  remarks: [],
  ...extra,
})

const LAMP = '6ba7b810-9dad-11d1-80b4-00c04fd430c8'
const PLUG = '6ba7b811-9dad-11d1-80b4-00c04fd430c8'

/** Fake dependencies that record what was asked and what was offered for download. */
function fakes(
  stored: { name: string; client?: string } | undefined,
  devices: readonly DeviceDocument[] = [device(LAMP), device(PLUG, { room: 'Hall' })],
) {
  const asked: string[] = []
  const downloads: { bytes: Uint8Array; filename: string }[] = []
  const deps: ExportDependencies = {
    devices: async (dbName) => {
      asked.push(`devices ${dbName}`)
      return devices
    },
    projectDocument: async (dbName) => {
      asked.push(`project ${dbName}`)
      return stored
    },
    now: () => at(14, 30),
    download: (bytes, filename) => downloads.push({ bytes, filename }),
  }
  return { deps, asked, downloads }
}

/** The one download's files, read back as the import reads them. */
async function offered(downloads: readonly { bytes: Uint8Array }[]): Promise<readonly ZipEntry[]> {
  expect(downloads).toHaveLength(1)
  return readZip((downloads[0] as { bytes: Uint8Array }).bytes, streamCodecs, ARCHIVE_LIMITS)
}

const row = { dbName: 'project_p1', name: 'Shown name', client: 'Shown client' }

describe('exporting a project', () => {
  it('reads the database the row names', async () => {
    const { deps, asked } = fakes({ name: 'Hillside' })

    await exportProject(row, deps)

    expect(asked.sort()).toEqual(['devices project_p1', 'project project_p1'])
  })

  it('takes the name and client from the project document', async () => {
    // The document is what travels with the data; the row is only what the page shows.
    const { deps, downloads } = fakes({ name: 'Hillside', client: 'Acme' })

    await exportProject(row, deps)

    expect(downloads[0]?.filename).toBe('Hillside 2026-10-19.zip')
    const { project } = readProjectArchive(await offered(downloads))
    expect(project).toEqual({ name: 'Hillside', client: 'Acme' })
  })

  it('records no client when the project document has none', async () => {
    const { deps, downloads } = fakes({ name: 'Hillside' })

    await exportProject(row, deps)

    expect(readProjectArchive(await offered(downloads)).project).toEqual({ name: 'Hillside' })
  })

  it('falls back to the row when the database has no project document', async () => {
    // The first-run catalogue may have none.
    const { deps, downloads } = fakes(undefined)

    await exportProject(row, deps)

    expect(downloads[0]?.filename).toBe('Shown name 2026-10-19.zip')
    expect(readProjectArchive(await offered(downloads)).project).toEqual({
      name: 'Shown name',
      client: 'Shown client',
    })
  })

  it('falls back to a row with no client without inventing one', async () => {
    const { deps, downloads } = fakes(undefined)

    await exportProject({ dbName: 'project_local_a', name: 'Alpha' }, deps)

    expect(readProjectArchive(await offered(downloads)).project).toEqual({ name: 'Alpha' })
  })

  it('offers a zip the import reads back to the same devices', async () => {
    const { deps, downloads } = fakes({ name: 'Hillside' })

    await exportProject(row, deps)

    const { devices, refiled } = readProjectArchive(await offered(downloads))
    expect(refiled).toBe(0)
    expect(devices.map((each) => [each._id, each.name, each.room]).sort()).toEqual([
      [`device:${LAMP}`, `Lamp ${LAMP}`, 'Ground Floor/Kitchen'],
      [`device:${PLUG}`, `Lamp ${PLUG}`, 'Hall'],
    ])
    // Replication state and the repository's stamp stay behind.
    for (const each of devices) {
      expect(each).not.toHaveProperty('_rev')
      expect(each).not.toHaveProperty('updatedAt')
    }
  })

  it('stamps the manifest with the moment of the export', async () => {
    const { deps, downloads } = fakes({ name: 'Hillside' })

    await exportProject(row, deps)

    const manifest = (await offered(downloads)).find((entry) => entry.name === 'manifest.json')
    const parsed = JSON.parse(new TextDecoder().decode(manifest?.data)) as {
      exportedAt: string
      devices: number
    }
    expect(parsed.exportedAt).toBe(at(14, 30).toISOString())
    expect(parsed.devices).toBe(2)
  })

  it('exports a project with no devices', async () => {
    const { deps, downloads } = fakes({ name: 'Empty' }, [])

    await exportProject(row, deps)

    expect(readProjectArchive(await offered(downloads)).devices).toEqual([])
  })

  it('offers nothing when the devices cannot be read', async () => {
    const { deps, downloads } = fakes({ name: 'Hillside' })
    const failing: ExportDependencies = {
      ...deps,
      devices: async () => Promise.reject(new Error('indexed_db_went_bad')),
    }

    await expect(exportProject(row, failing)).rejects.toThrow('indexed_db_went_bad')
    expect(downloads).toEqual([])
  })
})

describe('a project with no name yet', () => {
  // The first-run project has none until it is named. The import refuses a nameless archive,
  // so the export must still write one, or the backup could not be restored.
  it('takes the row’s name when the project document’s is blank', async () => {
    const { deps, downloads } = fakes({ name: '  ' })

    await exportProject(row, deps)

    expect(readProjectArchive(await offered(downloads)).project.name).toBe('Shown name')
  })

  it('is exported as an unnamed project when nothing names it, and imports back', async () => {
    const { deps, downloads } = fakes({ name: '' })

    await exportProject({ dbName: 'project_local_a', name: '' }, deps)

    expect(downloads[0]?.filename).toBe('Unnamed project 2026-10-19.zip')
    expect(readProjectArchive(await offered(downloads)).project.name).toBe('Unnamed project')
  })
})

describe('an export the import could not read back', () => {
  it('is refused, and nothing is offered, past the number of files an import reads', async () => {
    const many = Array.from({ length: ARCHIVE_LIMITS.maxEntries - 1 }, (_, n) => device(`d${n}`))
    const { deps, downloads } = fakes({ name: 'Hillside' }, many)

    const failure = await exportProject(row, deps).catch((error: unknown) => error)

    expect(failure).toBeInstanceOf(ZipError)
    expect((failure as ZipError).problem).toBe('tooLarge')
    expect(downloads).toEqual([])
  })

  it('is refused past the inflated size an import reads', async () => {
    // Remarks are free text, so a few large devices reach the limit without many files.
    const remark = (n: number) => ({
      id: `r${n}`,
      text: 'x'.repeat(1024 * 1024),
      authorSub: 'sub-a',
      authorName: 'A',
      createdAt: '2026-10-01T08:00:00.000Z',
    })
    const heavy = Array.from({ length: 51 }, (_, n) => device(`h${n}`, { remarks: [remark(n)] }))
    const { deps, downloads } = fakes({ name: 'Hillside' }, heavy)

    const failure = await exportProject(row, deps).catch((error: unknown) => error)

    expect((failure as ZipError).problem).toBe('tooLarge')
    expect(downloads).toEqual([])
  })

  it('is offered at exactly the number of files an import reads', async () => {
    const most = Array.from({ length: ARCHIVE_LIMITS.maxEntries - 2 }, (_, n) => device(`d${n}`))
    const { deps, downloads } = fakes({ name: 'Hillside' }, most)

    await exportProject(row, deps)

    expect(readProjectArchive(await offered(downloads)).devices).toHaveLength(most.length)
  })
})

describe('reading the project document', () => {
  const failing = (error: unknown) => ({ get: async () => Promise.reject(error) })

  it('is none when the database has no project document', async () => {
    expect(await projectDocumentIn(failing({ status: 404, name: 'not_found' }))).toBeUndefined()
  })

  it('fails, rather than exporting under the page’s name, when the read fails', async () => {
    const broken = { status: 500, name: 'unknown_error' }
    await expect(projectDocumentIn(failing(broken))).rejects.toBe(broken)
  })

  it('is the document when it is one', async () => {
    const stored = { _id: 'project', type: 'project', name: 'Hillside' }
    expect(await projectDocumentIn({ get: async () => stored })).toMatchObject({
      name: 'Hillside',
    })
  })
})
