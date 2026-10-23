/**
 * Importing a project export: a zip of JSON documents becomes a new local-only project.
 *
 * Always a new project, never merged into an existing one: a merge would need a decision per
 * field about whose copy wins, and a new project can be shared afterwards like any other. The
 * file is read and every device validated before anything is written (`readZip`,
 * `readProjectArchive`); the write itself is all or nothing (`importLocalProject`).
 *
 * @module
 */

import type { LocalProjectEntry } from '../../data/index.js'
import { ARCHIVE_LIMITS, readProjectArchive } from '../../domain/archive/project-archive.js'
import { readZip, ZipError } from '../../domain/archive/zip.js'
import {
  importLocalProject,
  type LocalProjectDependencies,
  localProjectDefaults,
} from '../local-projects.js'
import { streamCodecs } from './codec.js'

/** What an import did. */
export interface ImportResult {
  readonly entry: LocalProjectEntry
  /** How many devices were written. */
  readonly devices: number
  /** How many of them had no usable room and were filed under `Imported`. */
  readonly refiled: number
}

/**
 * Imports one export file.
 *
 * @param file the chosen file; its size is checked before it is read, so a huge one is refused
 *   without being held in memory whole
 * @throws {ZipError} for a file that is not a readable zip within the limits
 * @throws {ArchiveError} for a zip that is not a project export, or holds a broken device
 * @throws whatever storage throws, after removing what was written
 */
export async function importProjectFile(
  file: Blob,
  deps: LocalProjectDependencies = localProjectDefaults,
): Promise<ImportResult> {
  if (file.size > ARCHIVE_LIMITS.maxBytes) {
    throw new ZipError('tooLarge', `The file is larger than ${ARCHIVE_LIMITS.maxBytes} bytes.`)
  }
  const bytes = new Uint8Array(await file.arrayBuffer())
  const imported = readProjectArchive(await readZip(bytes, streamCodecs, ARCHIVE_LIMITS))
  const entry = await importLocalProject(imported, deps)
  return { entry, devices: imported.devices.length, refiled: imported.refiled }
}
