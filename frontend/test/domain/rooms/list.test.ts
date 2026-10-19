import { describe, expect, it } from 'vitest'
import type { DeviceDocument } from '../../../src/domain/index.js'
import {
  documentId,
  RoomPathError,
  renameRoom,
  roomPathKey,
  roomsOf,
} from '../../../src/domain/index.js'

/**
 * The room list, derived from the devices (ADR 0021).
 *
 * There is no room document. A room is the set of devices whose `room` folds to one
 * `roomPathKey`, so the list is a pure function of the devices and a rename is a rewrite of
 * them. Like `documents/`, everything here **plans and does not write**: a rename returns the
 * devices to save, and only those that change.
 */

const device = (
  uuid: string,
  room: string,
  extra: Partial<DeviceDocument> = {},
): DeviceDocument => ({
  _id: documentId('device', uuid),
  _rev: `1-${uuid}`,
  updatedAt: '2026-08-20T08:00:00.000Z',
  type: 'device',
  name: 'A lamp',
  room,
  manualCode: '34970112332',
  installedAt: '2026-08-19',
  addedAt: '2026-08-19T08:00:00.000Z',
  disabled: false,
  remarks: [],
  ...extra,
})

/** A device written before ADR 0021: it has a `roomId` and no `room`. No repair is made. */
const legacy = (uuid: string): DeviceDocument => {
  const { room: _room, ...rest } = device(uuid, '')
  return { ...rest, roomId: 'room:gone' } as unknown as DeviceDocument
}

describe('the rooms the devices are in', () => {
  it('orders spellings a collator calls equal the same way, whichever device comes first', () => {
    // Composed and decomposed `Küche` fold to one room, and a locale collator compares them as
    // equal. Without a tiebreak, the first spelling (the link and the merge default) would be
    // whichever device was read first, and two replicas could disagree.
    const composed = 'K\u00fcche'
    const decomposed = 'Ku\u0308che'
    const collator = new Intl.Collator('de').compare
    const devices = [device('a', composed), device('b', decomposed)]

    const one = roomsOf(devices, collator)
    const other = roomsOf([...devices].reverse(), collator)

    expect(one).toHaveLength(1)
    expect(one[0]?.spellings).toHaveLength(2)
    expect(one[0]?.spellings).toEqual(other[0]?.spellings)
  })

  it('lists each path the devices carry, with how many devices are in it', () => {
    const rooms = roomsOf([
      device('a', 'Ground Floor/Kitchen'),
      device('b', 'Ground Floor/Kitchen'),
      device('c', 'Attic'),
    ])

    expect(rooms).toEqual([
      { key: roomPathKey('Attic'), spellings: ['Attic'], deviceCount: 1 },
      {
        key: roomPathKey('Ground Floor/Kitchen'),
        spellings: ['Ground Floor/Kitchen'],
        deviceCount: 2,
      },
    ])
  })

  it('is empty when there are no devices, because a room cannot exist without one', () => {
    expect(roomsOf([])).toEqual([])
  })

  it('groups the spellings of one room by key, and lists them all', () => {
    // Two people typed the kitchen differently before their devices synced. Neither spelling
    // is chosen as the room's real name; the page shows all three and offers a merge.
    const rooms = roomsOf([
      device('a', 'kitchen'),
      device('b', 'Kitchen'),
      device('c', 'kitCHEN'),
      device('d', 'Kitchen'),
    ])

    expect(rooms).toHaveLength(1)
    expect(rooms[0]?.key).toBe(roomPathKey('Kitchen'))
    expect(rooms[0]?.deviceCount).toBe(4)
  })

  it('sorts the spellings, so every replica lists them in the same order', () => {
    const one = roomsOf([device('a', 'kitchen'), device('b', 'Kitchen'), device('c', 'kitCHEN')])
    const other = roomsOf([device('c', 'kitCHEN'), device('a', 'kitchen'), device('b', 'Kitchen')])

    // Code-point order by default: upper case before lower case.
    expect(one[0]?.spellings).toEqual(['Kitchen', 'kitCHEN', 'kitchen'])
    expect(other[0]?.spellings).toEqual(one[0]?.spellings)
  })

  it('counts a disabled device, which is still in a room', () => {
    // A room that vanished while its only device was out of service would be a rename nobody
    // could reach.
    const rooms = roomsOf([device('a', 'Cellar', { disabled: true })])

    expect(rooms).toEqual([{ key: roomPathKey('Cellar'), spellings: ['Cellar'], deviceCount: 1 }])
  })

  it('counts devices filed exactly here, not those in sub-rooms', () => {
    const rooms = roomsOf([
      device('a', 'Ground Floor'),
      device('b', 'Ground Floor/Kitchen'),
      device('c', 'Ground Floor/Kitchen'),
    ])

    expect(rooms.map((room) => [room.spellings[0], room.deviceCount])).toEqual([
      ['Ground Floor', 1],
      ['Ground Floor/Kitchen', 2],
    ])
  })

  it('leaves out a device with no room, rather than listing an empty one', () => {
    // A document from before ADR 0021 has `roomId` and no `room`. It must not crash the page,
    // and it must not appear as a room with no name.
    const rooms = roomsOf([legacy('old'), device('a', ''), device('b', '  '), device('c', 'Hall')])

    expect(rooms.map((room) => room.spellings)).toEqual([['Hall']])
  })

  it('sorts rooms segment by segment, so a sub-room follows its parent (#242)', () => {
    const rooms = roomsOf([
      device('a', 'Attic Bedroom'),
      device('b', 'Attic/Studio'),
      device('c', 'Attic'),
      device('d', 'Cellar'),
    ])

    expect(rooms.map((room) => room.spellings[0])).toEqual([
      'Attic',
      'Attic/Studio',
      'Attic Bedroom',
      'Cellar',
    ])
  })

  it('orders segments with the comparator it is given', () => {
    // The web layer passes its locale collator, so the list sorts as the device list does.
    const reversed = (a: string, b: string): number => (a < b ? 1 : a > b ? -1 : 0)
    const rooms = roomsOf([device('a', 'Attic'), device('b', 'Cellar')], reversed)

    expect(rooms.map((room) => room.spellings[0])).toEqual(['Cellar', 'Attic'])
  })
})

describe('renaming a room', () => {
  it('rewrites every device in the room and in the rooms inside it', () => {
    const renamed = renameRoom(
      [
        device('a', 'Floor 1'),
        device('b', 'Floor 1/Kitchen'),
        device('c', 'Floor 1/Kitchen/Pantry'),
      ],
      'Floor 1',
      'Ground Floor',
    )

    expect(renamed.map((entry) => entry.room)).toEqual([
      'Ground Floor',
      'Ground Floor/Kitchen',
      'Ground Floor/Kitchen/Pantry',
    ])
  })

  it('returns only the devices that change', () => {
    // On a shared project every document rewritten is one somebody else's phone downloads.
    const renamed = renameRoom(
      [device('a', 'Floor 1/Kitchen'), device('b', 'Attic'), device('c', 'Floor 10/Kitchen')],
      'Floor 1',
      'Ground Floor',
    )

    expect(renamed.map((entry) => entry._id)).toEqual([documentId('device', 'a')])
  })

  it('returns nothing when no device is in the room', () => {
    expect(renameRoom([device('a', 'Attic')], 'Cellar', 'Basement')).toEqual([])
  })

  it('returns nothing when the new name is the old one', () => {
    expect(renameRoom([device('a', 'Attic')], 'Attic', 'Attic')).toEqual([])
  })

  it('merges every spelling of the room into one', () => {
    // Rename doubles as merge: every spelling folds to the key being renamed, so every one is
    // rewritten and afterwards the room is listed once, with one spelling.
    const devices = [device('a', 'Kitchen'), device('b', 'kitchen'), device('c', 'kitCHEN')]
    const renamed = renameRoom(devices, 'Kitchen', 'Kitchen')

    // `Kitchen` itself does not change, so it is not returned; the other two are.
    expect(renamed.map((entry) => [entry._id, entry.room])).toEqual([
      [documentId('device', 'b'), 'Kitchen'],
      [documentId('device', 'c'), 'Kitchen'],
    ])
    const after = devices.map((one) => renamed.find((entry) => entry._id === one._id) ?? one)
    expect(roomsOf(after as DeviceDocument[])).toEqual([
      { key: roomPathKey('Kitchen'), spellings: ['Kitchen'], deviceCount: 3 },
    ])
  })

  it('merges the spellings of a sub-room too, keeping what lies below', () => {
    const renamed = renameRoom(
      [device('a', 'ground floor/Pantry'), device('b', 'GROUND FLOOR')],
      'Ground Floor',
      'Ground Floor',
    )

    expect(renamed.map((entry) => entry.room)).toEqual(['Ground Floor/Pantry', 'Ground Floor'])
  })

  it('merges into a room that already exists, needing no special case', () => {
    // A room is nothing but the devices in it, so filing these under `Hall` is the merge.
    const devices = [device('a', 'Hallway'), device('b', 'Hall')]
    const renamed = renameRoom(devices, 'Hallway', 'Hall')

    expect(renamed.map((entry) => [entry._id, entry.room])).toEqual([
      [documentId('device', 'a'), 'Hall'],
    ])
  })

  it('drops updatedAt, which the repository owns', () => {
    // It is half of the total order the conflict merge depends on (ADR 0010).
    const [renamed] = renameRoom([device('a', 'Attic')], 'Attic', 'Loft')

    expect(renamed).toBeDefined()
    expect(renamed).not.toHaveProperty('updatedAt')
  })

  it('carries the rest of each device through untouched', () => {
    const original = device('a', 'Attic', { spot: 'by the hatch', disabled: true })
    const [renamed] = renameRoom([original], 'Attic', 'Loft')

    const { updatedAt: _stamp, ...rest } = original
    expect(renamed).toEqual({ ...rest, room: 'Loft' })
  })

  it('does not modify the devices it was given', () => {
    const devices = [device('a', 'Attic')]
    const snapshot = JSON.stringify(devices)

    renameRoom(devices, 'Attic', 'Loft')

    expect(JSON.stringify(devices)).toBe(snapshot)
  })

  it('passes over a device with no room', () => {
    expect(renameRoom([legacy('old'), device('a', '')], 'Attic', 'Loft')).toEqual([])
  })

  it('is safe to repeat after a partial failure', () => {
    // A device already renamed is no longer inside `from`, so a retry does not touch it again.
    const devices = [device('a', 'Floor 1/Kitchen'), device('b', 'Floor 1/Hall')]
    const [first] = renameRoom(devices, 'Floor 1', 'Ground Floor')
    if (first === undefined) throw new Error('the rename should have changed device a')

    const retry = renameRoom(
      [
        { ...first, updatedAt: '2026-08-21T08:00:00.000Z' } as DeviceDocument,
        devices[1] as DeviceDocument,
      ],
      'Floor 1',
      'Ground Floor',
    )

    expect(retry.map((entry) => entry._id)).toEqual([documentId('device', 'b')])
  })

  it('refuses an unusable path at either end', () => {
    const devices = [device('a', 'Attic')]

    expect(() => renameRoom(devices, '', 'Loft')).toThrow(RoomPathError)
    expect(() => renameRoom(devices, 'Attic', 'Lo//ft')).toThrow(RoomPathError)
  })
})
