import { describe, expect, it } from 'vitest'
import type { DeviceDocument } from '../../src/index.js'
import {
  devicesInRoom,
  documentId,
  planRoomDeletion,
  type RoomDocument,
  renameRoom,
  reorderRooms,
  roomsInOrder,
} from '../../src/index.js'

/**
 * Editing the room list (M5-9).
 *
 * `path.ts` answers questions about one path. This is the layer above: what a whole list of
 * rooms becomes when one is renamed, reordered or deleted, and what happens to the devices
 * that were in it.
 *
 * Every function here **plans and does not write**, like `documents/`. The caller performs the
 * writes, which is what lets a deletion that touches a room, a new room and nine devices be
 * decided in one pure function and then written in whatever order the store needs.
 */

const id = (uuid: string): string => documentId('room', uuid)

const room = (uuid: string, path: string, sortKey?: number): RoomDocument => ({
  _id: id(uuid),
  _rev: `1-${uuid}`,
  updatedAt: '2026-08-20T08:00:00.000Z',
  type: 'room',
  path,
  ...(sortKey === undefined ? {} : { sortKey }),
})

const device = (uuid: string, roomId: string, name = 'A lamp'): DeviceDocument => ({
  _id: documentId('device', uuid),
  _rev: `1-${uuid}`,
  updatedAt: '2026-08-20T08:00:00.000Z',
  type: 'device',
  name,
  roomId,
  manualCode: '34970112332',
  installedAt: '2026-08-19',
  addedAt: '2026-08-19T08:00:00.000Z',
  disabled: false,
  remarks: [],
})

const KITCHEN = room('kitchen', 'Ground Floor/Kitchen')
const HALL = room('hall', 'Ground Floor/Hall')
const ATTIC = room('attic', 'Attic')

const uuids = (...values: readonly string[]): (() => string) => {
  let index = 0
  return () => {
    const value = values[index] ?? values[values.length - 1]
    index += 1
    if (value === undefined) throw new Error('the test needs at least one uuid')
    return value
  }
}

describe('the order rooms are shown in', () => {
  it('puts the ones somebody arranged first, in that order', () => {
    const ordered = roomsInOrder([room('c', 'C', 2), room('a', 'A', 0), room('b', 'B', 1)])

    expect(ordered.map((entry) => entry.path)).toEqual(['A', 'B', 'C'])
  })

  it('puts never-arranged rooms after them, by path', () => {
    // Not interleaved by any invented position. A room nobody has placed has no place, and
    // guessing one would move it the first time somebody dragged something else.
    const ordered = roomsInOrder([room('z', 'Attic'), room('a', 'Cellar', 0)])

    expect(ordered.map((entry) => entry.path)).toEqual(['Cellar', 'Attic'])
  })

  it('is stable for two rooms nobody has arranged', () => {
    const ordered = roomsInOrder([room('b', 'Ground Floor/Kitchen'), room('a', 'Attic')])

    expect(ordered.map((entry) => entry.path)).toEqual(['Attic', 'Ground Floor/Kitchen'])
  })

  it('does not modify the list it was given', () => {
    // `sort` is in place, and a comparator applied to the caller's array would reorder a room
    // list somebody else is rendering.
    const rooms = [room('b', 'B', 1), room('a', 'A', 0)]

    roomsInOrder(rooms)

    expect(rooms.map((entry) => entry.path)).toEqual(['B', 'A'])
  })
})

describe('reordering', () => {
  it('numbers the rooms in the order given', () => {
    const changed = reorderRooms([ATTIC._id, KITCHEN._id, HALL._id], [KITCHEN, HALL, ATTIC])

    expect(changed.map((entry) => [entry._id, entry.sortKey])).toEqual([
      [ATTIC._id, 0],
      [KITCHEN._id, 1],
      [HALL._id, 2],
    ])
  })

  it('returns only the rooms whose position actually changed', () => {
    // A drag moves one room past another. Rewriting all forty would replicate forty documents,
    // and on a shared project every one of them is a change somebody else's device downloads.
    const rooms = [room('a', 'A', 0), room('b', 'B', 1), room('c', 'C', 2)]

    const changed = reorderRooms([id('a'), id('c'), id('b')], rooms)

    expect(changed.map((entry) => entry._id)).toEqual([id('c'), id('b')])
  })

  it('carries the rest of each room through untouched', () => {
    const changed = reorderRooms([HALL._id, KITCHEN._id], [KITCHEN, HALL])

    expect(changed[0]).toMatchObject({ _id: HALL._id, path: 'Ground Floor/Hall', _rev: '1-hall' })
  })

  it('refuses an order that is not the whole list', () => {
    // A partial order has no meaning: it says where two rooms go and nothing about the rest,
    // so any answer would be invented. Refusing is the only honest option, and a silent
    // "reorder what I recognise" would drop a room off the end of the list.
    expect(() => reorderRooms([KITCHEN._id], [KITCHEN, HALL])).toThrow(RangeError)
  })

  it('refuses an order naming a room that is not there', () => {
    expect(() => reorderRooms([KITCHEN._id, id('nowhere')], [KITCHEN, HALL])).toThrow(RangeError)
  })

  it('refuses an order naming the same room twice', () => {
    expect(() => reorderRooms([KITCHEN._id, KITCHEN._id], [KITCHEN, HALL])).toThrow(RangeError)
  })
})

describe('renaming a room', () => {
  it('renames the room and everything inside it', () => {
    const rooms = [room('gf', 'Ground Floor'), KITCHEN, HALL, ATTIC]

    const changed = renameRoom('Ground Floor', 'Erdgeschoss', rooms)

    expect(changed.map((entry) => entry.path).sort()).toEqual([
      'Erdgeschoss',
      'Erdgeschoss/Hall',
      'Erdgeschoss/Kitchen',
    ])
  })

  it('leaves rooms that merely start with the same letters alone', () => {
    // The failure this guards against does not look wrong afterwards: `Floor 10/Kitchen` moves
    // into a building it was never in, and the room list still reads plausibly.
    const rooms = [room('a', 'Floor 1/Kitchen'), room('b', 'Floor 10/Kitchen')]

    const changed = renameRoom('Floor 1', 'Ground Floor', rooms)

    expect(changed.map((entry) => entry.path)).toEqual(['Ground Floor/Kitchen'])
  })

  it('returns nothing when no room is affected', () => {
    expect(renameRoom('Cellar', 'Basement', [KITCHEN, ATTIC])).toEqual([])
  })

  it('carries each renamed room through with its revision', () => {
    // Without the `_rev` the caller cannot save the room it was just handed, and a rename
    // becomes a create.
    const changed = renameRoom('Attic', 'Loft', [ATTIC])

    expect(changed[0]).toMatchObject({ _id: ATTIC._id, path: 'Loft', _rev: '1-attic' })
  })

  it('refuses a rename onto a room that already exists', () => {
    // Two documents with the same path are two rooms a person cannot tell apart, which is the
    // duplicate M1-5 and M2-5 both exist to prevent — reached here through the one door
    // nobody was watching.
    expect(() => renameRoom('Attic', 'Ground Floor/Kitchen', [KITCHEN, ATTIC])).toThrow(RangeError)
  })

  it('refuses when a descendant would collide', () => {
    // The subtle half: the room being renamed is fine, and one of the rooms it drags with it
    // lands on top of something else.
    const rooms = [room('gf', 'Ground Floor'), KITCHEN, room('uk', 'Upper Floor/Kitchen')]

    expect(() => renameRoom('Ground Floor', 'Upper Floor', rooms)).toThrow(RangeError)
  })

  it('refuses a rename onto a room that differs only in ways nobody would notice', () => {
    // `ground floor / kitchen` is the same room to a reader. ADR 0006 keeps case meaningful
    // for storage, and M1-5 decided people do not read it that way.
    expect(() => renameRoom('Attic', 'ground floor / kitchen', [KITCHEN, ATTIC])).toThrow(
      RangeError,
    )
  })

  it('does not treat a room as colliding with itself', () => {
    // Renaming `Attic` to `Attic ` is a rename to the same path once normalised. The collision
    // check must not object — the only room it matches is the one being renamed — and, since
    // nothing actually moves, there is nothing to write either.
    expect(renameRoom('Attic', 'Attic ', [ATTIC])).toEqual([])
  })

  it('allows a room to be renamed past one that is also moving', () => {
    // `Ground Floor/Kitchen` lands where `Ground Floor/Hall` was, and `Hall` has itself moved
    // on. Comparing against the whole list rather than against the rooms staying put would
    // call that a collision and refuse a rename that is perfectly well defined.
    const rooms = [room('a', 'Ground Floor/Kitchen'), room('b', 'Ground Floor/Kitchen/Sink')]

    const changed = renameRoom('Ground Floor/Kitchen', 'Ground Floor/Kitchen/Sink', rooms)

    expect(changed.map((entry) => entry.path).sort()).toEqual([
      'Ground Floor/Kitchen/Sink',
      'Ground Floor/Kitchen/Sink/Sink',
    ])
  })
})

describe('the devices a deletion would strand', () => {
  it('finds the ones pointing at the room', () => {
    const devices = [device('a', KITCHEN._id), device('b', ATTIC._id), device('c', KITCHEN._id)]

    expect(devicesInRoom(KITCHEN._id, devices).map((entry) => entry._id)).toEqual([
      documentId('device', 'a'),
      documentId('device', 'c'),
    ])
  })

  it('is empty for a room nothing is in', () => {
    // What the interface checks to decide whether it has to ask anything at all.
    expect(devicesInRoom(ATTIC._id, [device('a', KITCHEN._id)])).toEqual([])
  })

  it('counts a disabled device, which is still a device somewhere', () => {
    const disabled = { ...device('a', KITCHEN._id), disabled: true }

    expect(devicesInRoom(KITCHEN._id, [disabled])).toHaveLength(1)
  })
})

describe('deleting a room that has devices in it', () => {
  const devices = [device('a', KITCHEN._id), device('b', ATTIC._id)]

  it('moves them to the room that was chosen', () => {
    const plan = planRoomDeletion(
      KITCHEN._id,
      [KITCHEN, HALL, ATTIC],
      devices,
      { kind: 'room', roomId: HALL._id },
      uuids('unused'),
    )

    expect(plan.remove).toBe(KITCHEN)
    expect(plan.reassign.map((entry) => [entry._id, entry.roomId])).toEqual([
      [documentId('device', 'a'), HALL._id],
    ])
    expect(plan.create).toBeUndefined()
  })

  it('moves them to Unassigned when that is what was chosen', () => {
    const plan = planRoomDeletion(
      KITCHEN._id,
      [KITCHEN, HALL],
      devices,
      { kind: 'unassigned' },
      uuids('new-unassigned'),
    )

    // The room has to exist before a device can point at it, so the plan carries it.
    expect(plan.create).toMatchObject({ path: 'Unassigned', type: 'room' })
    expect(plan.reassign[0]?.roomId).toBe(plan.create?._id)
  })

  it('reuses an Unassigned room that is already there', () => {
    const unassigned = room('unassigned', 'Unassigned')

    const plan = planRoomDeletion(
      KITCHEN._id,
      [KITCHEN, unassigned],
      devices,
      { kind: 'unassigned' },
      uuids('should-not-be-used'),
    )

    // A second `Unassigned` would be two rooms with one name — exactly what `chooseRoom`
    // exists to prevent everywhere else.
    expect(plan.create).toBeUndefined()
    expect(plan.reassign[0]?.roomId).toBe(unassigned._id)
  })

  it('leaves every other device alone', () => {
    const plan = planRoomDeletion(
      KITCHEN._id,
      [KITCHEN, HALL],
      devices,
      { kind: 'room', roomId: HALL._id },
      uuids('unused'),
    )

    expect(plan.reassign.map((entry) => entry._id)).not.toContain(documentId('device', 'b'))
  })

  it('carries each moved device through whole', () => {
    // A reassignment is not an edit of anything else. Rebuilding the device here would be a
    // rewrite of the one document shape where a rewrite loses remarks.
    const withRemark: DeviceDocument = {
      ...device('a', KITCHEN._id),
      spot: 'ceiling, north end',
      remarks: [
        {
          id: 'r1',
          text: 'Replaced batteries',
          authorSub: 'sub',
          authorName: 'Anna',
          createdAt: '2026-08-19T09:00:00.000Z',
        },
      ],
    }

    const plan = planRoomDeletion(
      KITCHEN._id,
      [KITCHEN, HALL],
      [withRemark],
      { kind: 'room', roomId: HALL._id },
      uuids('unused'),
    )

    expect(plan.reassign[0]).toMatchObject({
      spot: 'ceiling, north end',
      remarks: withRemark.remarks,
      _rev: '1-a',
    })
  })

  it('does not stamp updatedAt, which the repository owns', () => {
    const plan = planRoomDeletion(
      KITCHEN._id,
      [KITCHEN, HALL],
      devices,
      { kind: 'room', roomId: HALL._id },
      uuids('unused'),
    )

    // Half of the total order the conflict merge depends on (ADR 0010). A device saved with a
    // stale stamp does not fail; it quietly loses every future conflict.
    expect(plan.reassign[0]).not.toHaveProperty('updatedAt')
  })
})

describe('deleting a room, refusals', () => {
  it('refuses a room that is not in the list', () => {
    expect(() =>
      planRoomDeletion(
        id('nowhere'),
        [KITCHEN],
        [],
        { kind: 'room', roomId: KITCHEN._id },
        uuids('unused'),
      ),
    ).toThrow(RangeError)
  })

  it('refuses to move devices into the room being deleted', () => {
    // Reads as a no-op and is not one: the room goes, and every device in it now points at a
    // document that does not exist.
    expect(() =>
      planRoomDeletion(
        KITCHEN._id,
        [KITCHEN],
        [device('a', KITCHEN._id)],
        { kind: 'room', roomId: KITCHEN._id },
        uuids('unused'),
      ),
    ).toThrow(RangeError)
  })

  it('refuses a destination that does not exist', () => {
    expect(() =>
      planRoomDeletion(
        KITCHEN._id,
        [KITCHEN],
        [device('a', KITCHEN._id)],
        { kind: 'room', roomId: id('nowhere') },
        uuids('unused'),
      ),
    ).toThrow(RangeError)
  })

  it('still deletes a room nothing is in', () => {
    const plan = planRoomDeletion(
      ATTIC._id,
      [KITCHEN, ATTIC],
      [device('a', KITCHEN._id)],
      { kind: 'unassigned' },
      uuids('unused'),
    )

    // A destination is required even here, and that is the point: there is no way to express
    // "delete it and see what happens". Nothing is moved and nothing is created, because
    // nothing was in it.
    expect(plan.reassign).toEqual([])
    expect(plan.create).toBeUndefined()
  })
})
