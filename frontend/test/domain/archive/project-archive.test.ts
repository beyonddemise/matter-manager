import { describe, expect, it } from 'vitest'
import {
  ARCHIVE_FORMAT,
  ARCHIVE_VERSION,
  ArchiveError,
  IMPORTED_ROOM,
  projectArchiveEntries,
  readProjectArchive,
} from '../../../src/domain/archive/project-archive.js'
import type { ZipEntry } from '../../../src/domain/archive/zip.js'
import type { DeviceDocument } from '../../../src/domain/index.js'

/**
 * A project as a set of JSON files, and back.
 *
 * The export side is plain serialisation. The import side is the interesting one: the file
 * came from somewhere else, so every device is rebuilt through `planNewDevice` from its setup
 * code rather than trusted field by field, and anything that does not hold together is refused
 * with the file it was found in.
 */

const EXPORTED_AT = '2026-10-19T15:00:00.000Z'

/**
 * The standard SDK test device, as `new-device.test.ts` pins it (lesson L1). The payload
 * carries vendor and product ids, so the manual code derived from it is the 21-digit long form;
 * the 11-digit one is what a device with only a manual code has.
 */
const PAYLOAD = 'MT:Y.K9042C00KA0648G00'
const LONG_MANUAL = '749701123365521327687'
const MANUAL = '34970112332'

const device = (uuid: string, extra: Partial<DeviceDocument> = {}): DeviceDocument => ({
  _id: `device:${uuid}`,
  _rev: '3-abc',
  updatedAt: '2026-10-01T08:00:00.000Z',
  type: 'device',
  name: 'Kitchen light',
  room: 'Ground Floor/Kitchen',
  manualCode: MANUAL,
  installedAt: '2026-08-19',
  addedAt: '2026-08-19T08:00:00.000Z',
  disabled: false,
  remarks: [],
  ...extra,
})

const json = (entry: ZipEntry | undefined): unknown =>
  JSON.parse(new TextDecoder().decode(entry?.data ?? new Uint8Array()))

const entry = (name: string, value: unknown): ZipEntry => ({
  name,
  data: new TextEncoder().encode(typeof value === 'string' ? value : JSON.stringify(value)),
})

const manifest = (extra: object = {}) =>
  entry('manifest.json', {
    format: ARCHIVE_FORMAT,
    version: ARCHIVE_VERSION,
    exportedAt: EXPORTED_AT,
    ...extra,
  })

const archiveOf = (...devices: unknown[]): ZipEntry[] => [
  manifest(),
  entry('project.json', { name: 'Hillside' }),
  ...devices.map((value, index) => entry(`devices/${index}.json`, value)),
]

/** The problem code `readProjectArchive` refuses with, or `undefined` if it accepts. */
const problemOf = (entries: readonly ZipEntry[]): string | undefined => {
  try {
    readProjectArchive(entries)
    return undefined
  } catch (error) {
    return error instanceof ArchiveError ? error.problem : `not an ArchiveError: ${String(error)}`
  }
}

describe('exporting', () => {
  it('writes a manifest, the project and one file per device', () => {
    const entries = projectArchiveEntries(
      { name: 'Hillside', client: 'Ms Example' },
      [device('a'), device('b')],
      EXPORTED_AT,
    )

    expect(entries.map((e) => e.name)).toEqual([
      'manifest.json',
      'project.json',
      'devices/a.json',
      'devices/b.json',
    ])
    expect(json(entries[0])).toEqual({
      format: ARCHIVE_FORMAT,
      version: ARCHIVE_VERSION,
      exportedAt: EXPORTED_AT,
      devices: 2,
    })
    expect(json(entries[1])).toEqual({ name: 'Hillside', client: 'Ms Example' })
  })

  it('leaves out the replication state and the repository stamp', () => {
    const stored = {
      ...device('a'),
      _conflicts: ['2-x'],
      _attachments: {},
    } as unknown as DeviceDocument

    const [, , file] = projectArchiveEntries({ name: 'Hillside' }, [stored], EXPORTED_AT)
    const written = json(file) as Record<string, unknown>

    expect(written).not.toHaveProperty('_rev')
    expect(written).not.toHaveProperty('_conflicts')
    expect(written).not.toHaveProperty('_attachments')
    expect(written).not.toHaveProperty('updatedAt')
    expect(written._id).toBe('device:a')
    expect(written.room).toBe('Ground Floor/Kitchen')
  })

  it('omits a client that is not set', () => {
    const [, project] = projectArchiveEntries({ name: 'Hillside' }, [], EXPORTED_AT)

    expect(json(project)).toEqual({ name: 'Hillside' })
  })
})

describe('importing what was exported', () => {
  it('gives back the project and its devices', () => {
    const remark = {
      id: 'r1',
      text: 'Replaced batteries',
      authorSub: 'sub',
      authorName: 'Sam',
      createdAt: '2026-09-01T10:00:00.000Z',
    }
    const original = device('a', {
      payload: PAYLOAD,
      manualCode: LONG_MANUAL,
      spot: 'ceiling',
      serial: 'SN1',
      disabled: true,
      disabledAt: '2026-09-02T10:00:00.000Z',
      remarks: [remark],
      vendorName: 'Acme',
      productName: 'Lamp',
      productUrl: 'https://acme.example/lamp',
      catalogCheckedAt: '2026-09-01T00:00:00.000Z',
      catalogSource: 'found',
    })

    const imported = readProjectArchive(
      projectArchiveEntries({ name: 'Hillside', client: 'Ms Example' }, [original], EXPORTED_AT),
    )

    expect(imported.project).toEqual({ name: 'Hillside', client: 'Ms Example' })
    expect(imported.refiled).toBe(0)
    const { _rev: _r, updatedAt: _u, ...expected } = original
    expect(imported.devices).toEqual([expect.objectContaining(expected)])
    expect(imported.devices[0]).not.toHaveProperty('_rev')
  })

  it('accepts an archive with no devices', () => {
    const imported = readProjectArchive(projectArchiveEntries({ name: 'Empty' }, [], EXPORTED_AT))

    expect(imported.devices).toEqual([])
  })
})

describe('rebuilding each device rather than trusting it', () => {
  it('derives the credential fields from the payload, not from the file', () => {
    const forged = {
      ...device('a', { payload: PAYLOAD, manualCode: LONG_MANUAL }),
      vendorId: 1,
      productId: 2,
    }

    const [rebuilt] = readProjectArchive(archiveOf(forged)).devices

    // The SDK test device: vendor 0xFFF1, product 0x8000.
    expect(rebuilt?.vendorId).toBe(0xfff1)
    expect(rebuilt?.productId).toBe(0x8000)
  })

  it('refuses a payload and a manual code that disagree', () => {
    const mismatched = device('a', { payload: PAYLOAD, manualCode: '00000000000' })

    expect(problemOf(archiveOf(mismatched))).toBe('badDevice')
  })

  it('refuses a manual code that fails its check digit', () => {
    expect(problemOf(archiveOf(device('a', { manualCode: '34970112331' })))).toBe('badDevice')
  })

  it('files a device without a usable room under Imported, and counts it', () => {
    const imported = readProjectArchive(
      archiveOf(device('a', { room: '' }), device('b', { room: 'Floor//Kitchen' }), device('c')),
    )

    expect(imported.devices.map((d) => d.room)).toEqual([
      IMPORTED_ROOM,
      IMPORTED_ROOM,
      'Ground Floor/Kitchen',
    ])
    expect(imported.refiled).toBe(2)
  })

  it('files a device written before rooms moved onto devices under Imported', () => {
    const { room: _room, ...legacy } = device('a')

    const [rebuilt] = readProjectArchive(archiveOf({ ...legacy, roomId: 'room:x' })).devices

    expect(rebuilt?.room).toBe(IMPORTED_ROOM)
    expect(rebuilt).not.toHaveProperty('roomId')
  })

  it('drops a catalogue link that is not https', () => {
    const [rebuilt] = readProjectArchive(
      archiveOf(
        device('a', {
          productUrl: 'javascript:alert(1)',
          supportUrl: 'https://ok.example',
          catalogCheckedAt: '2026-09-01T00:00:00.000Z',
          catalogSource: 'found',
        }),
      ),
    ).devices

    expect(rebuilt).not.toHaveProperty('productUrl')
    expect(rebuilt?.supportUrl).toBe('https://ok.example')
  })

  it('drops a catalogue block that does not say when or what was found', () => {
    // Without these two the block cannot be told from a lookup that never happened; dropping it
    // lets the backfill ask the catalogue again.
    const [rebuilt] = readProjectArchive(
      archiveOf(device('a', { vendorName: 'Acme', catalogSource: 'found' })),
    ).devices

    expect(rebuilt).not.toHaveProperty('vendorName')
    expect(rebuilt).not.toHaveProperty('catalogSource')
  })

  it('drops fields a device does not have', () => {
    const [rebuilt] = readProjectArchive(
      archiveOf({ ...device('a'), owner: 'someone', _deleted: true }),
    ).devices

    expect(rebuilt).not.toHaveProperty('owner')
    expect(rebuilt).not.toHaveProperty('_deleted')
  })

  it('keeps a disabled device disabled, and its date', () => {
    const [rebuilt] = readProjectArchive(
      archiveOf(device('a', { disabled: true, disabledAt: '2026-09-02T10:00:00.000Z' })),
    ).devices

    expect(rebuilt?.disabled).toBe(true)
    expect(rebuilt?.disabledAt).toBe('2026-09-02T10:00:00.000Z')
  })

  it('refuses a remark that is not a remark', () => {
    const broken = { ...device('a'), remarks: [{ text: 'no id' }] }

    expect(problemOf(archiveOf(broken))).toBe('badDevice')
  })

  it('refuses an id that is not a device id', () => {
    expect(problemOf(archiveOf({ ...device('a'), _id: 'room:a' }))).toBe('badDevice')
    expect(problemOf(archiveOf({ ...device('a'), _id: 'project' }))).toBe('badDevice')
  })

  it('refuses two devices with one id', () => {
    expect(problemOf(archiveOf(device('a'), device('a')))).toBe('badDevice')
  })

  it('refuses a device without a name, and says which file', () => {
    try {
      readProjectArchive(archiveOf(device('a'), device('b', { name: '  ' })))
      expect.unreachable()
    } catch (error) {
      expect(error).toBeInstanceOf(ArchiveError)
      expect((error as ArchiveError).problem).toBe('badDevice')
      expect((error as ArchiveError).file).toBe('devices/1.json')
    }
  })

  it('refuses a device file that is not JSON', () => {
    const entries = [...archiveOf(), entry('devices/x.json', '{not json')]

    expect(problemOf(entries)).toBe('badDevice')
  })
})

describe('refusing what is not a project archive', () => {
  it('without a manifest', () => {
    expect(problemOf([entry('project.json', { name: 'x' })])).toBe('notAProject')
  })

  it('with somebody else’s manifest', () => {
    expect(
      problemOf([
        entry('manifest.json', { format: 'something-else', version: 1 }),
        entry('project.json', { name: 'x' }),
      ]),
    ).toBe('notAProject')
  })

  it('from a newer version of the application', () => {
    expect(
      problemOf([manifest({ version: ARCHIVE_VERSION + 1 }), entry('project.json', { name: 'x' })]),
    ).toBe('newerVersion')
  })

  it('without a project name', () => {
    expect(problemOf([manifest(), entry('project.json', { name: ' ' })])).toBe('notAProject')
    expect(problemOf([manifest()])).toBe('notAProject')
  })

  it('ignores files outside devices/, so a note added to the zip does no harm', () => {
    const imported = readProjectArchive([...archiveOf(device('a')), entry('README.txt', 'hi')])

    expect(imported.devices).toHaveLength(1)
  })
})
