/**
 * Exporting a project: this device's copy, as a zip of JSON documents, offered as a download.
 *
 * Reads only the local database, so it works offline and for any role: an export is a backup of
 * what this device holds, not of what the server may have since. The format is
 * `domain/archive/project-archive.ts`; the container `domain/archive/zip.ts`.
 *
 * **Refused for a project locked on this device** (#303; spec, "Locked projects"): the format is
 * plaintext, and a locked read carries no codes, so the archive would be a backup with every
 * commissioning secret missing — one its own import refuses.
 *
 * @module
 */

import { msg } from '@lit/localize'
import { isLockedDocument, ProjectLockedError } from '../../data/index.js'
import { ARCHIVE_LIMITS, projectArchiveEntries } from '../../domain/archive/project-archive.js'
import { writeZip, type ZipEntry, ZipError } from '../../domain/archive/zip.js'
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
  projectDocument: (dbName) => projectDocumentIn(rawDatabase(dbName)),
  now: () => new Date(),
  download: (bytes, filename) => offerDownload(bytes, filename, document, 'application/zip'),
}

/**
 * The database's `project` document, or `undefined` when it has none.
 *
 * Only a 404 means "none". Any other failure is thrown: exporting under the name the page shows
 * would hide that the database could not be read, and label the backup with a stale name.
 */
export async function projectDocumentIn(database: {
  readonly get: (id: string) => Promise<unknown>
}): Promise<{ readonly name: string; readonly client?: string } | undefined> {
  let stored: unknown
  try {
    stored = await database.get(PROJECT_DOCUMENT_ID)
  } catch (error) {
    if ((error as { status?: unknown } | null)?.status === 404) return undefined
    throw error
  }
  return isProjectDocument(stored) ? stored : undefined
}

/**
 * Refuses an archive the import would refuse, so no backup is offered that cannot be restored.
 *
 * The same limits {@link ARCHIVE_LIMITS} the reader enforces: files and inflated size before
 * compressing, the file's size after.
 *
 * @throws {ZipError} `tooLarge`
 */
function checkLimits(entries: readonly ZipEntry[], zipped?: Uint8Array): void {
  const inflated = entries.reduce((sum, entry) => sum + entry.data.length, 0)
  if (
    entries.length > ARCHIVE_LIMITS.maxEntries ||
    inflated > ARCHIVE_LIMITS.maxInflatedBytes ||
    (zipped !== undefined && zipped.length > ARCHIVE_LIMITS.maxBytes)
  ) {
    throw new ZipError('tooLarge', 'The project is larger than an import can read.')
  }
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
 * @throws {ProjectLockedError} when the project is locked on this device; nothing is offered
 */
export async function exportProject(
  row: { readonly dbName: string; readonly name: string; readonly client?: string },
  deps: ExportDependencies = exportDefaults,
): Promise<void> {
  const [devices, stored] = await Promise.all([
    deps.devices(row.dbName),
    deps.projectDocument(row.dbName),
  ])
  // Before anything is built, so no partial archive exists even in memory. One locked document
  // is enough: the key state is per project. A locked project with no devices holds no codes
  // to lose and exports as the empty project it is.
  if (devices.some(isLockedDocument)) throw new ProjectLockedError('exporting')
  const now = deps.now()
  const project = stored ?? {
    name: row.name,
    ...(row.client === undefined ? {} : { client: row.client }),
  }
  // Never blank: the import refuses an archive that names no project, and the first-run project
  // has no name until it is given one. The page's own label for it stands in.
  const name =
    [project.name, row.name].map((candidate) => candidate.trim()).find((n) => n !== '') ??
    msg('Unnamed project')
  const entries = projectArchiveEntries(
    { name, ...(project.client === undefined ? {} : { client: project.client }) },
    devices,
    now.toISOString(),
  )
  checkLimits(entries)
  const zipped = await writeZip(entries, streamCodecs, now)
  checkLimits(entries, zipped)
  deps.download(zipped, exportFilename(name, now))
}
