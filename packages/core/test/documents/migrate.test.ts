import { describe, expect, it } from 'vitest'
import { planMigration } from '../../src/documents/migrate.js'
import type { DeviceDocument, RoomDocument } from '../../src/documents/types.js'

/**
 * Moving the catalogue that lives only on this device into a project (#55).
 *
 * The hard part is not copying documents; it is the rooms. Both catalogues name rooms by path,
 * and ADR 0006 already decided that `Ground Floor/Kitchen` and `ground floor / kitchen` are the
 * same room. A move that copied rooms by id would put a second Kitchen in a project that has
 * one — the duplicate M1-5 and M2-5 exist to prevent, arriving through a door nobody was
 * watching.
 */

const room = (id: string, path: string): RoomDocument => ({
  _id: id,
  _rev: '1-a',
  updatedAt: '2026-08-31T09:00:00.000Z',
  type: 'room',
  path,
})

const device = (id: string, name: string, roomId: string): DeviceDocument => ({
  _id: id,
  _rev: '1-a',
  updatedAt: '2026-08-31T09:00:00.000Z',
  type: 'device',
  name,
  roomId,
  manualCode: '34970112332',
  installedAt: '2026-08-31',
  addedAt: '2026-08-31T09:00:00.000Z',
  disabled: false,
  remarks: [],
})

/** A uuid source that counts, so the plan is readable. */
const counter = () => {
  let next = 0
  return () => `new-${++next}`
}

describe('moving devices into a project that already has rooms', () => {
  it('files a device into the room the target already has', () => {
    const plan = planMigration(
      [device('device:lamp', 'Kitchen lamp', 'room:local-kitchen')],
      [room('room:local-kitchen', 'Ground Floor/Kitchen')],
      [room('room:target-kitchen', 'Ground Floor/Kitchen')],
      counter(),
    )

    expect(plan.rooms).toEqual([])
    expect(plan.devices[0]?.roomId).toBe('room:target-kitchen')
  })

  it('matches the room however it was capitalised', () => {
    // ADR 0006: `Ground Floor/Kitchen` and `ground floor / kitchen` are the same room, and
    // `roomPathKey` is the one answer to that question. A second answer here would be a second
    // Kitchen.
    const plan = planMigration(
      [device('device:lamp', 'Kitchen lamp', 'room:local-kitchen')],
      [room('room:local-kitchen', 'ground floor / kitchen')],
      [room('room:target-kitchen', 'Ground Floor/Kitchen')],
      counter(),
    )

    expect(plan.rooms).toEqual([])
    expect(plan.devices[0]?.roomId).toBe('room:target-kitchen')
  })

  it('creates a room the target does not have', () => {
    const plan = planMigration(
      [device('device:porch', 'Porch light', 'room:local-porch')],
      [room('room:local-porch', 'Porch')],
      [],
      counter(),
    )

    expect(plan.rooms).toHaveLength(1)
    expect(plan.rooms[0]?.path).toBe('Porch')
    expect(plan.devices[0]?.roomId).toBe(plan.rooms[0]?._id)
  })

  it('creates a room once for several devices in it', () => {
    const plan = planMigration(
      [
        device('device:one', 'One', 'room:local-porch'),
        device('device:two', 'Two', 'room:local-porch'),
      ],
      [room('room:local-porch', 'Porch')],
      [],
      counter(),
    )

    expect(plan.rooms).toHaveLength(1)
    expect(plan.devices[0]?.roomId).toBe(plan.devices[1]?.roomId)
  })

  it('keeps each device’s own id', () => {
    // The same id in the target, so a move interrupted half way and retried writes the same
    // document again rather than a second copy of it.
    const plan = planMigration(
      [device('device:lamp', 'Kitchen lamp', 'room:local-kitchen')],
      [room('room:local-kitchen', 'Kitchen')],
      [],
      counter(),
    )

    expect(plan.devices[0]?._id).toBe('device:lamp')
  })

  it('carries no revision from the catalogue it came from', () => {
    // A `_rev` belongs to the database that issued it. Writing one into another database is a
    // conflict at best and a document nobody can update at worst.
    const plan = planMigration(
      [device('device:lamp', 'Kitchen lamp', 'room:local-kitchen')],
      [room('room:local-kitchen', 'Kitchen')],
      [],
      counter(),
    )

    expect(plan.devices[0]).not.toHaveProperty('_rev')
    expect(plan.rooms[0]).not.toHaveProperty('_rev')
  })

  it('keeps everything else about the device', () => {
    const plan = planMigration(
      [device('device:lamp', 'Kitchen lamp', 'room:local-kitchen')],
      [room('room:local-kitchen', 'Kitchen')],
      [],
      counter(),
    )

    expect(plan.devices[0]).toMatchObject({
      name: 'Kitchen lamp',
      manualCode: '34970112332',
      installedAt: '2026-08-31',
    })
  })

  it('moves a device that belongs to no room at all', () => {
    // Possible for a document written by an older build, and losing it would be the one
    // outcome a move must never have.
    const plan = planMigration([device('device:stray', 'Stray', 'room:missing')], [], [], counter())

    expect(plan.devices).toHaveLength(1)
    expect(plan.devices[0]?.roomId).toBe('room:missing')
  })

  it('plans nothing for an empty catalogue', () => {
    const plan = planMigration([], [], [], counter())
    expect(plan).toEqual({ rooms: [], devices: [] })
  })

  it('does not carry across a room nothing is in', () => {
    // An empty room in the target would be a room somebody has to tidy up, for no benefit: the
    // move is about not losing devices.
    const plan = planMigration([], [room('room:local-empty', 'Cellar')], [], counter())
    expect(plan.rooms).toEqual([])
  })
})
