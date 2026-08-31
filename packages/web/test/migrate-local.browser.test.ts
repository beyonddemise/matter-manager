import type { DeviceDocument } from '@matter-manager/core'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { migrateLocalCatalogue } from '../src/migrate-local.js'
import { browserDatabase, type TestDatabase } from './support/browser-database.js'

/**
 * #55's third scenario, as the maintainer decided it: the catalogue on this device can be moved
 * into a project deliberately, rather than being stranded or silently discarded.
 *
 * Against real databases rather than stubs. What is being tested is an ordering — written
 * first, removed second — and a stub would let both happen in whatever order the test wrote
 * them in, which is exactly the thing that must not be assumed.
 */

let local: TestDatabase
let project: TestDatabase

const device = (
  id: string,
  name: string,
  roomId: string,
): Omit<DeviceDocument, '_rev' | 'updatedAt'> => ({
  _id: id,
  type: 'device',
  name,
  roomId,
  manualCode: '34970112332',
  installedAt: '2026-08-31',
  addedAt: '2026-08-31T09:00:00.000Z',
  disabled: false,
  remarks: [],
})

beforeEach(() => {
  local = browserDatabase()
  project = browserDatabase()
})

afterEach(async () => {
  await local.destroy()
  await project.destroy()
})

describe('moving the catalogue on this device into a project', () => {
  it('puts the devices in the project', async () => {
    await local.repositories.rooms.save({ _id: 'room:kitchen', type: 'room', path: 'Kitchen' })
    await local.repositories.devices.save(device('device:lamp', 'Kitchen lamp', 'room:kitchen'))

    const result = await migrateLocalCatalogue(local.repositories, project.repositories)

    expect(result.devicesMoved).toBe(1)
    const moved = await project.repositories.devices.list()
    expect(moved.map((d) => d.name)).toEqual(['Kitchen lamp'])
  })

  it('empties the catalogue it moved them from', async () => {
    await local.repositories.rooms.save({ _id: 'room:kitchen', type: 'room', path: 'Kitchen' })
    await local.repositories.devices.save(device('device:lamp', 'Kitchen lamp', 'room:kitchen'))

    const result = await migrateLocalCatalogue(local.repositories, project.repositories)

    expect(result.localCleared).toBe(true)
    expect(await local.repositories.devices.list()).toEqual([])
  })

  it('reuses a room the project already has', async () => {
    // ADR 0006 decided that `Ground Floor/Kitchen` and `ground floor / kitchen` are the same
    // room. A move that ignored that would put a second Kitchen in the project.
    await project.repositories.rooms.save({
      _id: 'room:target',
      type: 'room',
      path: 'Ground Floor/Kitchen',
    })
    await local.repositories.rooms.save({
      _id: 'room:local',
      type: 'room',
      path: 'ground floor / kitchen',
    })
    await local.repositories.devices.save(device('device:lamp', 'Kitchen lamp', 'room:local'))

    await migrateLocalCatalogue(local.repositories, project.repositories)

    const rooms = await project.repositories.rooms.list()
    expect(rooms).toHaveLength(1)
    const [moved] = await project.repositories.devices.list()
    expect(moved?.roomId).toBe('room:target')
  })

  it('creates a room the project does not have', async () => {
    await local.repositories.rooms.save({ _id: 'room:porch', type: 'room', path: 'Porch' })
    await local.repositories.devices.save(device('device:porch', 'Porch light', 'room:porch'))

    const result = await migrateLocalCatalogue(local.repositories, project.repositories)

    expect(result.roomsCreated).toBe(1)
    expect((await project.repositories.rooms.list()).map((r) => r.path)).toEqual(['Porch'])
  })

  it('leaves the local catalogue intact when a write fails', async () => {
    // The ordering that matters. Of the two possible half-finished states - the devices in both
    // catalogues, or in neither - only one loses nothing.
    await local.repositories.rooms.save({ _id: 'room:kitchen', type: 'room', path: 'Kitchen' })
    await local.repositories.devices.save(device('device:lamp', 'Kitchen lamp', 'room:kitchen'))

    const refusing = {
      ...project.repositories,
      devices: {
        ...project.repositories.devices,
        save: async () => {
          throw new Error('storage refused')
        },
      },
    }

    await expect(migrateLocalCatalogue(local.repositories, refusing)).rejects.toThrow()
    expect(await local.repositories.devices.list()).toHaveLength(1)
  })

  it('rejects moving a catalogue into itself without removing anything', async () => {
    await local.repositories.rooms.save({ _id: 'room:kitchen', type: 'room', path: 'Kitchen' })
    await local.repositories.devices.save(device('device:lamp', 'Kitchen lamp', 'room:kitchen'))

    await expect(migrateLocalCatalogue(local.repositories, local.repositories)).rejects.toThrow()
    expect(await local.repositories.devices.list()).toHaveLength(1)
    expect(await local.repositories.rooms.list()).toHaveLength(1)
  })

  it('does nothing at all for an empty catalogue', async () => {
    const result = await migrateLocalCatalogue(local.repositories, project.repositories)
    expect(result).toEqual({ devicesMoved: 0, roomsCreated: 0, localCleared: true })
  })

  it('can be run twice without duplicating anything', async () => {
    // Each device keeps its id, so a move interrupted and retried writes the same document
    // again rather than a second copy of it.
    await local.repositories.rooms.save({ _id: 'room:kitchen', type: 'room', path: 'Kitchen' })
    await local.repositories.devices.save(device('device:lamp', 'Kitchen lamp', 'room:kitchen'))

    await migrateLocalCatalogue(local.repositories, project.repositories)
    await local.repositories.rooms.save({ _id: 'room:kitchen', type: 'room', path: 'Kitchen' })
    await local.repositories.devices.save(device('device:lamp', 'Kitchen lamp', 'room:kitchen'))
    await migrateLocalCatalogue(local.repositories, project.repositories)

    expect(await project.repositories.devices.list()).toHaveLength(1)
  })
})
