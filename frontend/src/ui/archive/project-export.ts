/**
 * Exporting a project: this device's copy, as a zip of JSON documents, offered as a download.
 *
 * Reads only the local database, so it works offline and for any role: an export is a backup of
 * what this device holds, not of what the server may have since. The format is
 * `domain/archive/project-archive.ts`; the container `domain/archive/zip.ts`.
 *
 * @module
 */

import { projectArchiveEntries } from '../../domain/archive/project-archive.js'
import { writeZip } from '../../domain/archive/zip.js'
import { isProjectDocument, PROJECT_DOCUMENT_ID } from '../../domain/documents/project.js'
import type { DeviceDocument } from '../../domain/index.js'
import { openProject, rawDatabase } from '../db/project-database.js'
import { offerDownload } from '../pdf/download.js'
import { streamCodecs } from './codec.js'

/** What an export touches; injectable so a test need not own the browser's databases. */
export interface ExportDependencies {
  readonly devices: (dbName: string) => Promise<readonly DeviceDocument[]>
  /** The `project` document's name and client, when the database has one. */
  readonly projectDocument: (
    dbName: string,
  ) => Promise<{ readonly name: string; readonly client?: string } | undefined>
  readonly now: () => Date
  readonly download: (bytes: Uint8Array, filename: string) => void
}

/** The real databases and the browser's download. */
export const exportDefaults: ExportDependencies = {
  devices: (dbName) => openProject(dbName).devices.list(),
  async projectDocument(dbName) {
    const stored = await rawDatabase(dbName)
      .get(PROJECT_DOCUMENT_ID)
      .catch(() => undefined)
    return isProjectDocument(stored) ? stored : undefined
  },
  now: () => new Date(),
  download: (bytes, filename) => offerDownload(bytes, filename, document, 'application/zip'),
}

/**
 * The file name: the project's name made safe for a file system, then the local date.
 *
 * Characters Windows and macOS refuse in a name are replaced, not dropped, so `A/B` stays
 * readable as `A-B`. An empty result falls back to `project`.
 */
export function exportFilename(name: string, now: Date): string {
  const local = new Date(now.getTime() - now.getTimezoneOffset() * 60_000)
  const safe = name
    .replace(/[\\/:*?"<>|]/g, '-')
    .replace(/\s+/g, ' ')
    .trim()
  return `${safe === '' ? 'project' : safe} ${local.toISOString().slice(0, 10)}.zip`
}

/**
 * Exports one project's copy on this device.
 *
 * @param row which database, and the name the page shows (used when the database has no
 *   `project` document, as the first-run catalogue may not)
 */
export async function exportProject(
  row: { readonly dbName: string; readonly name: string; readonly client?: string },
  deps: ExportDependencies = exportDefaults,
): Promise<void> {
  const [devices, stored] = await Promise.all([
    deps.devices(row.dbName),
    deps.projectDocument(row.dbName),
  ])
  const now = deps.now()
  const project = stored ?? {
    name: row.name,
    ...(row.client === undefined ? {} : { client: row.client }),
  }
  const entries = projectArchiveEntries(
    { name: project.name, ...(project.client === undefined ? {} : { client: project.client }) },
    devices,
    now.toISOString(),
  )
  deps.download(await writeZip(entries, streamCodecs, now), exportFilename(project.name, now))
}
