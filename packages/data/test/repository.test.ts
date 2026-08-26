import {
  type DeviceDocument,
  documentId,
  type RoomDocument,
  type Unsaved,
} from '@matter-manager/core'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { type ProjectRepositories, projectRepositories } from '../src/index.js'
import { fixedClock, memoryDatabase } from './support/memory-database.js'

const KITCHEN = documentId('room', '3fa85f64-5717-4562-b3fc-2c963f66afa6')
const LAMP = documentId('device', '6ba7b810-9dad-11d1-80b4-00c04fd430c8')

/**
 * A device with every optional field populated.
 *
 * Deliberately not a minimal fixture: the story's first scenario is "every field is preserved,
 * including remarks", and a fixture that omits the optional half cannot show that.
 */
const lamp = (): Unsaved<DeviceDocument> => ({
  _id: LAMP,
  type: 'device',
  name: 'Kitchen ceiling light',
  roomId: KITCHEN,
  spot: 'ceiling, north end',
  payload: 'MT:Y.K9042C00KA0648G00',
  manualCode: '34970112332',
  vendorId: 0xfff1,
  productId: 0x8000,
  discriminator: 3840,
  vendorName: 'Example GmbH',
  productName: 'Smart Bulb A60',
  deviceTypeId: 266,
  serial: 'SN-000123',
  installedAt: '2026-08-19',
  addedAt: '2026-08-19T08:00:00.000Z',
  disabled: false,
  remarks: [
    {
      id: '9f8e7d6c-1234-4567-89ab-cdef01234567',
      text: 'Replaced batteries',
      authorSub: 'auth0|abc123',
      authorName: 'Stephan',
      createdAt: '2026-08-19T09:30:00.000Z',
    },
  ],
})

const kitchen = (): Unsaved<RoomDocument> => ({
  _id: KITCHEN,
  type: 'room',
  path: 'Ground Floor/Kitchen',
  sortKey: 100,
})

let database: PouchDB.Database
let repositories: ProjectRepositories

beforeEach(() => {
  database = memoryDatabase()
  repositories = projectRepositories(database, fixedClock('2026-08-20T10:00:00.000Z'))
})

afterEach(async () => {
  await database.destroy()
})

describe('a device round trip', () => {
  it('preserves every field, remarks included', async () => {
    const original = lamp()
    const saved = await repositories.devices.save(original)
    const readBack = await repositories.devices.get(LAMP)

    expect(readBack).toEqual(saved)
    // Field by field against the input rather than against the save's return value, so that a
    // repository which dropped a field on the way in AND on the way out could not agree with
    // itself and pass.
    for (const [key, value] of Object.entries(original)) {
      expect(readBack?.[key as keyof DeviceDocument]).toEqual(value)
    }
    expect(readBack?.remarks).toHaveLength(1)
    expect(readBack?.remarks[0]?.text).toBe('Replaced batteries')
  })

  it('gives the stored document a revision and a timestamp', async () => {
    const saved = await repositories.devices.save(lamp())
    expect(saved._rev).toMatch(/^1-/)
    expect(saved.updatedAt).toBe('2026-08-20T10:00:00.000Z')
  })
})

describe('save', () => {
  it('stamps updatedAt from the clock, and the caller cannot override it', async () => {
    const clock = fixedClock('2026-01-01T00:00:00.000Z', '2026-02-02T00:00:00.000Z')
    const repos = projectRepositories(database, clock)

    const first = await repos.devices.save(lamp())
    expect(first.updatedAt).toBe('2026-01-01T00:00:00.000Z')

    // `updatedAt` is not in `Unsaved`, so this is the only way a caller could smuggle one in.
    const second = await repos.devices.save({
      ...first,
      updatedAt: '1999-12-31T00:00:00.000Z',
    } as Unsaved<DeviceDocument>)
    expect(second.updatedAt).toBe('2026-02-02T00:00:00.000Z')
  })

  it('updates in place when given the revision it read', async () => {
    const first = await repositories.devices.save(lamp())
    const second = await repositories.devices.save({ ...first, name: 'Kitchen spotlight' })

    expect(second._rev).toMatch(/^2-/)
    expect((await repositories.devices.get(LAMP))?.name).toBe('Kitchen spotlight')
    expect(await repositories.devices.list()).toHaveLength(1)
  })

  it('refuses a stale revision rather than overwriting', async () => {
    const first = await repositories.devices.save(lamp())
    await repositories.devices.save({ ...first, name: 'renamed once' })

    // Two clients editing the same device is the ordinary case; a repository that silently
    // won here would discard whichever write arrived second.
    await expect(repositories.devices.save({ ...first, name: 'renamed twice' })).rejects.toThrow()
  })

  it('refuses a document whose id belongs to another type', async () => {
    // Saved through the wrong repository, a document lands outside both prefix ranges' reach:
    // it reads back by id and appears in no list at all.
    await expect(
      repositories.devices.save(kitchen() as unknown as Unsaved<DeviceDocument>),
    ).rejects.toThrow(/room:/)
  })

  it('refuses an id this application does not write at all', async () => {
    // `meta:project` is a real document in the data model, but it carries no type prefix and
    // so belongs to no repository. Saying "not one this application writes" is more useful
    // than naming a type that does not exist.
    await expect(repositories.devices.save({ ...lamp(), _id: 'meta:project' })).rejects.toThrow(
      /not one this application writes/,
    )
  })

  it('stamps an ISO-8601 UTC timestamp when no clock is supplied', async () => {
    // The default clock is not a detail: the merge string-compares `updatedAt`, so a format
    // that did not sort chronologically would break conflict resolution and nothing else.
    const before = new Date().toISOString()
    const saved = await projectRepositories(database).devices.save(lamp())
    const after = new Date().toISOString()

    expect(saved.updatedAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/)
    expect(saved.updatedAt >= before && saved.updatedAt <= after).toBe(true)
  })
})

describe('get', () => {
  it('returns undefined for a document that is not there', async () => {
    expect(await repositories.devices.get(LAMP)).toBeUndefined()
  })

  it('returns undefined after the document is removed', async () => {
    const saved = await repositories.devices.save(lamp())
    await repositories.devices.remove(saved)
    expect(await repositories.devices.get(LAMP)).toBeUndefined()
  })

  it('propagates a failure that is not a missing document', async () => {
    // Swallowing everything would turn an outage into an empty catalogue, which reads as "your
    // devices are gone". Its own database, closed rather than destroyed, so the shared
    // teardown is not left with a handle it cannot use.
    const closed = memoryDatabase()
    await closed.close()

    await expect(projectRepositories(closed, fixedClock('x')).devices.get(LAMP)).rejects.toThrow(
      /closed/i,
    )
  })
})

describe('list', () => {
  it('returns the documents of its own type and nothing else', async () => {
    await repositories.devices.save(lamp())
    await repositories.rooms.save(kitchen())

    const devices = await repositories.devices.list()
    const rooms = await repositories.rooms.list()

    expect(devices.map((device) => device._id)).toEqual([LAMP])
    expect(rooms.map((room) => room._id)).toEqual([KITCHEN])
  })

  it('excludes an id that sorts immediately after the range', async () => {
    // `;` is the character right after `:`, so `device;…` is the closest thing to a device id
    // that is not one. Devices and rooms are far apart alphabetically, so the test above
    // passes with a far too generous endkey; this is the one that pins the bound.
    await repositories.devices.save(lamp())
    await database.put({ _id: 'device;not-a-device', type: 'device' })

    expect((await repositories.devices.list()).map((device) => device._id)).toEqual([LAMP])
  })

  it('is empty when nothing has been written', async () => {
    expect(await repositories.devices.list()).toEqual([])
  })

  it('does not list a removed document', async () => {
    const saved = await repositories.devices.save(lamp())
    await repositories.devices.remove(saved)

    // A ranged `_all_docs` omits deleted documents, so no tombstone reaches the mapping. That
    // was checked against the adapter rather than inferred - an earlier version of this file
    // claimed the opposite in a comment and passed anyway.
    expect(await repositories.devices.list()).toEqual([])
  })

  it('returns documents in id order', async () => {
    const second = documentId('device', 'ffffffff-0000-0000-0000-000000000000')
    const first = documentId('device', '00000000-0000-0000-0000-000000000000')
    await repositories.devices.save({ ...lamp(), _id: second })
    await repositories.devices.save({ ...lamp(), _id: first })

    expect((await repositories.devices.list()).map((device) => device._id)).toEqual([first, second])
  })
})

describe('remove', () => {
  it('needs the revision, so it cannot race a concurrent write', async () => {
    const first = await repositories.devices.save(lamp())
    await repositories.devices.save({ ...first, name: 'renamed' })

    await expect(repositories.devices.remove(first)).rejects.toThrow()
    expect(await repositories.devices.get(LAMP)).toBeDefined()
  })
})
