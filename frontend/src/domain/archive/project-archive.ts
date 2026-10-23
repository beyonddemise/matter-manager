/**
 * A project as a set of JSON files: what an export writes and an import reads back.
 *
 * ```
 * manifest.json          { format, version, exportedAt, devices }
 * project.json           { name, client? }
 * devices/<uuid>.json    one device document each
 * ```
 *
 * One file per device so a person can open the zip and read, or diff, a single device. The
 * container is `zip.ts`; this module only decides what goes in the files and what comes out.
 *
 * **Importing does not trust the file.** It came from somewhere else and may have been edited,
 * so each device is rebuilt through `planNewDevice` from its setup code - the credential fields
 * are derived again rather than copied, and a payload that disagrees with its manual code is
 * refused - and only the fields a device has are carried over, each checked. Nothing here ever
 * puts a setup code into an error message; the file name says which device it was.
 *
 * @module
 */

import { CATALOG_FIELD_KEYS, isHttpsUrl } from '../catalog/copy.js'
import { DraftError } from '../documents/draft.js'
import { documentTypeOf, uuidOf } from '../documents/ids.js'
import { planNewDevice } from '../documents/new-device.js'
import type { CatalogSource, DeviceDocument, Unsaved } from '../documents/types.js'
import { isValidRoomPath } from '../rooms/path.js'
import type { Remark } from '../sync/merge.js'
import { decodeUtf8, encodeUtf8 } from '../text/utf8.js'
import type { ZipEntry, ZipLimits } from './zip.js'

/** What `manifest.json` says the archive is. Anything else is not one of ours. */
export const ARCHIVE_FORMAT = 'matter-manager-project'

/**
 * The shape this build writes and reads. An archive from a newer build is refused by name
 * rather than imported partially: a field it relies on would silently be dropped.
 */
export const ARCHIVE_VERSION = 1

/** The room a device is filed under when the archive gives it none that is usable. */
export const IMPORTED_ROOM = 'Imported'

/**
 * What an import may read. Generous for a house (a few hundred devices make well under 1 MB),
 * and small enough that a hostile file cannot exhaust a phone's memory.
 */
export const ARCHIVE_LIMITS: ZipLimits = {
  maxBytes: 5 * 1024 * 1024,
  maxInflatedBytes: 50 * 1024 * 1024,
  maxEntries: 10_002,
}

/** Why an archive could not be imported. A code, so the interface can translate it. */
export type ArchiveProblem =
  /** No manifest, another format, or no project name. */
  | 'notAProject'
  /** Written by a newer version of the application. */
  | 'newerVersion'
  /** One device does not hold together; {@link ArchiveError.file} says which. */
  | 'badDevice'

/** Thrown for an archive that cannot be imported. */
export class ArchiveError extends Error {
  override readonly name = 'ArchiveError'

  constructor(
    readonly problem: ArchiveProblem,
    message: string,
    /** The file inside the archive the problem is in, when it is one file. */
    readonly file?: string,
    options?: ErrorOptions,
  ) {
    super(message, options)
  }
}

/** The project as the archive describes it. */
export interface ArchivedProject {
  readonly name: string
  readonly client?: string
}

/** What an import produces: everything to write, nothing written. */
export interface ImportedProject {
  readonly project: ArchivedProject
  readonly devices: readonly Unsaved<DeviceDocument>[]
  /** How many devices had no usable room and were filed under {@link IMPORTED_ROOM}. */
  readonly refiled: number
}

const MANIFEST = 'manifest.json'
const PROJECT = 'project.json'
const DEVICES = 'devices/'

/** Replication state and the repository's stamp: not part of a device, so never exported. */
const NOT_EXPORTED = new Set(['_rev', '_conflicts', '_attachments', '_deleted', 'updatedAt'])

const file = (name: string, value: unknown): ZipEntry => ({
  name,
  data: encodeUtf8(`${JSON.stringify(value, null, 2)}\n`),
})

/**
 * The files of an export.
 *
 * @param project the project's name and client
 * @param devices every device, as stored
 * @param exportedAt ISO 8601, recorded in the manifest
 */
export function projectArchiveEntries(
  project: ArchivedProject,
  devices: readonly DeviceDocument[],
  exportedAt: string,
): ZipEntry[] {
  return [
    file(MANIFEST, {
      format: ARCHIVE_FORMAT,
      version: ARCHIVE_VERSION,
      exportedAt,
      devices: devices.length,
    }),
    file(PROJECT, {
      name: project.name,
      ...(project.client === undefined ? {} : { client: project.client }),
    }),
    ...devices.map((device) =>
      file(
        `${DEVICES}${uuidOf(device._id) ?? device._id}.json`,
        Object.fromEntries(Object.entries(device).filter(([key]) => !NOT_EXPORTED.has(key))),
      ),
    ),
  ]
}

/**
 * The characters a device's uuid may hold: those `crypto.randomUUID` writes, and underscores.
 *
 * Why: the uuid names the device's file on the next export (`devices/<uuid>.json`). A slash or
 * a dot there would write an archive that `readZip` refuses as unsafe, and a colon an id that
 * `documentId` refuses.
 */
const SAFE_UUID = /^[A-Za-z0-9_-]+$/

/** One file parsed as JSON, or `undefined` when it is not JSON at all. */
function parsed(entry: ZipEntry): unknown {
  try {
    return JSON.parse(decodeUtf8(entry.data)) as unknown
  } catch {
    return undefined
  }
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

/** Trimmed text, or `undefined` for anything that is not a non-blank string. */
function text(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined
  const trimmed = value.trim()
  return trimmed === '' ? undefined : trimmed
}

/** A timestamp string that parses, or `undefined`. */
function timestamp(value: unknown): string | undefined {
  return typeof value === 'string' && !Number.isNaN(Date.parse(value)) ? value : undefined
}

/** `{ [key]: value }`, or `{}` when there is no value; see `catalog/copy.ts`. */
const present = <V>(key: string, value: V | undefined): Record<string, V> =>
  value === undefined ? {} : { [key]: value }

const CATALOG_SOURCES: ReadonlySet<string> = new Set<CatalogSource>([
  'found',
  'missing',
  'test-vendor',
  'unusable',
])
const LINK_KEYS: ReadonlySet<string> = new Set([
  'productUrl',
  'supportUrl',
  'userManualUrl',
  'commissioningFlowUrl',
])

/**
 * The catalogue block, each field checked, or nothing.
 *
 * All or nothing on the two fields that make it a block: without `catalogCheckedAt` and a known
 * `catalogSource` the rest cannot be told apart from a lookup that never happened, and dropping
 * it lets the backfill ask the catalogue again, which is the honest outcome.
 */
function catalogBlock(value: Record<string, unknown>): Partial<DeviceDocument> {
  const checkedAt = timestamp(value.catalogCheckedAt)
  const source = typeof value.catalogSource === 'string' ? value.catalogSource : undefined
  if (checkedAt === undefined || source === undefined || !CATALOG_SOURCES.has(source)) return {}

  const block: Record<string, unknown> = { catalogCheckedAt: checkedAt, catalogSource: source }
  for (const key of CATALOG_FIELD_KEYS) {
    if (key === 'catalogCheckedAt' || key === 'catalogSource') continue
    const raw = value[key]
    if (key === 'deviceTypeId') {
      if (typeof raw === 'number' && Number.isInteger(raw) && raw > 0) block[key] = raw
    } else if (LINK_KEYS.has(key)) {
      // Rendered as a link on the device page, so only `https:`: an imported
      // `javascript:` URL is the classic way to turn a backup into an attack.
      const link = text(raw)
      if (isHttpsUrl(link)) block[key] = link
    } else {
      Object.assign(block, present(key, text(raw)))
    }
  }
  return block as Partial<DeviceDocument>
}

/** Remarks, each with every field it must have; `undefined` if any is malformed. */
function remarksOf(value: unknown): readonly Remark[] | undefined {
  if (value === undefined) return []
  if (!Array.isArray(value)) return undefined
  const remarks: Remark[] = []
  for (const item of value) {
    if (!isRecord(item)) return undefined
    const { id, text: body, authorSub, authorName, createdAt } = item
    if (
      typeof id !== 'string' ||
      id === '' ||
      typeof body !== 'string' ||
      typeof authorSub !== 'string' ||
      typeof authorName !== 'string' ||
      timestamp(createdAt) === undefined
    ) {
      return undefined
    }
    remarks.push({ id, text: body, authorSub, authorName, createdAt: createdAt as string })
  }
  return remarks
}

/**
 * Rebuilds one device from its file.
 *
 * @returns the device, and whether its room had to be replaced
 * @throws {ArchiveError} `badDevice`, naming the file, when it does not hold together
 */
function readDevice(entry: ZipEntry): {
  readonly device: Unsaved<DeviceDocument>
  readonly refiled: boolean
} {
  const refuse = (why: string, cause?: unknown): never => {
    throw new ArchiveError(
      'badDevice',
      `${entry.name}: ${why}`,
      entry.name,
      cause === undefined ? undefined : { cause },
    )
  }

  const value = parsed(entry)
  if (!isRecord(value)) return refuse('not a JSON object.')

  const id = value._id
  const uuid = typeof id === 'string' && documentTypeOf(id) === 'device' ? uuidOf(id) : undefined
  if (uuid === undefined || !SAFE_UUID.test(uuid)) return refuse('not a device id.')

  const addedAt = timestamp(value.addedAt)
  if (addedAt === undefined) return refuse('no valid "added" timestamp.')

  const remarks = remarksOf(value.remarks)
  if (remarks === undefined) return refuse('a remark is malformed.')

  const payload = text(value.payload)
  const manualCode = text(value.manualCode)
  const credential = payload ?? manualCode
  if (credential === undefined) return refuse('no setup code.')

  const room =
    typeof value.room === 'string' && isValidRoomPath(value.room) ? value.room : undefined
  const optional = (key: 'spot' | 'serial') =>
    typeof value[key] === 'string' ? { [key]: value[key] as string } : {}

  let planned: Unsaved<DeviceDocument>
  try {
    planned = planNewDevice(
      {
        credential,
        name: typeof value.name === 'string' ? value.name : '',
        room: room ?? IMPORTED_ROOM,
        installedAt: typeof value.installedAt === 'string' ? value.installedAt : '',
        ...optional('spot'),
        ...optional('serial'),
      },
      [],
      { uuid: () => uuid, now: () => addedAt },
    )
  } catch (cause) {
    // A DraftError names the field and never the code; anything else is a bug, not the file.
    if (cause instanceof DraftError) return refuse(`${cause.field} is not usable.`, cause)
    if (cause instanceof Error && cause.name === 'PayloadError') {
      return refuse('the setup code is not valid.', cause)
    }
    throw cause
  }

  // Both present: they must be the same code. A payload edited to match another device while
  // its manual code was not would otherwise import as one device carrying two identities.
  if (payload !== undefined && manualCode !== undefined && planned.manualCode !== manualCode) {
    return refuse('the payload and the manual code are different codes.')
  }

  const disabled = value.disabled === true
  const disabledAt = disabled ? timestamp(value.disabledAt) : undefined
  return {
    device: {
      ...planned,
      disabled,
      ...present('disabledAt', disabledAt),
      remarks,
      ...catalogBlock(value),
    },
    refiled: room === undefined,
  }
}

/**
 * Reads an archive's files back into a project and the devices to write.
 *
 * Plans and does not write, like the rest of this package: a refusal leaves nothing behind
 * because there is nothing here that could have written anything.
 *
 * @param entries the files, from `readZip`
 * @throws {ArchiveError} for an archive that is not a project, is from a newer version, or holds
 *   a device that does not hold together - the whole import is refused, never half of it
 */
export function readProjectArchive(entries: readonly ZipEntry[]): ImportedProject {
  const byName = new Map(entries.map((entry) => [entry.name, entry]))

  const manifestEntry = byName.get(MANIFEST)
  const manifest = manifestEntry === undefined ? undefined : parsed(manifestEntry)
  if (!isRecord(manifest) || manifest.format !== ARCHIVE_FORMAT) {
    throw new ArchiveError('notAProject', 'This is not a Matter Manager project export.')
  }
  if (typeof manifest.version !== 'number' || manifest.version > ARCHIVE_VERSION) {
    throw new ArchiveError('newerVersion', 'This export was made by a newer version.')
  }

  const projectEntry = byName.get(PROJECT)
  const project = projectEntry === undefined ? undefined : parsed(projectEntry)
  const name = isRecord(project) ? text(project.name) : undefined
  if (!isRecord(project) || name === undefined) {
    throw new ArchiveError('notAProject', 'The export does not name its project.')
  }
  const client = text(project.client)

  const devices: Unsaved<DeviceDocument>[] = []
  const seen = new Set<string>()
  let refiled = 0
  for (const entry of entries) {
    if (!entry.name.startsWith(DEVICES) || !entry.name.endsWith('.json')) continue
    const read = readDevice(entry)
    if (seen.has(read.device._id)) {
      throw new ArchiveError(
        'badDevice',
        `${entry.name}: a second device with the same id.`,
        entry.name,
      )
    }
    seen.add(read.device._id)
    devices.push(read.device)
    if (read.refiled) refiled++
  }

  return { project: { name, ...(client === undefined ? {} : { client }) }, devices, refiled }
}
