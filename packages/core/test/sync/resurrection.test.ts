import { describe, expect, it } from 'vitest'
import type { RoomDocument } from '../../src/documents/types.js'
import {
  DELETION_MEMORY_DAYS,
  type DeletedRoom,
  resurrectedRooms,
  worthRemembering,
} from '../../src/sync/resurrection.js'

/**
 * #125: a room you deleted comes back, and nothing says why.
 *
 * The outcome is correct — a live leaf beats a deleted one, and no device is orphaned. What was
 * missing is that the person who deleted it is told, so they can delete it again deliberately
 * rather than conclude the application ignored them.
 */

const room = (id: string, path: string): RoomDocument => ({
  _id: id,
  _rev: '2-b',
  updatedAt: '2026-09-02T10:00:00.000Z',
  type: 'room',
  path,
})

const deleted = (id: string, path: string, at = '2026-09-02T09:00:00.000Z'): DeletedRoom => ({
  roomId: id,
  path,
  deletedAt: at,
})

describe('noticing a deletion that did not stick', () => {
  it('reports a room that is present again', () => {
    const back = resurrectedRooms([deleted('room:k', 'Kitchen')], [room('room:k', 'Cocina')])

    expect(back).toHaveLength(1)
    expect(back[0]?.room.path).toBe('Cocina')
  })

  it('remembers what the room was called when it was deleted', () => {
    // The message has to name what the reader meant, not only what it is called now. "Kitchen
    // is back as Cocina" is an explanation; "Cocina is back" is a different puzzle.
    const back = resurrectedRooms([deleted('room:k', 'Kitchen')], [room('room:k', 'Cocina')])
    expect(back[0]?.deleted.path).toBe('Kitchen')
  })

  it('matches by id, because the name is exactly what changed', () => {
    // A path comparison would find nothing precisely when there is something to find.
    const back = resurrectedRooms([deleted('room:k', 'Kitchen')], [room('room:k', 'Utterly Other')])
    expect(back).toHaveLength(1)
  })

  it('says nothing about a deletion that stuck', () => {
    expect(resurrectedRooms([deleted('room:k', 'Kitchen')], [])).toEqual([])
  })

  it('says nothing about a room somebody else created with a new id', () => {
    // A different room that happens to share a name is not a resurrection, and telling somebody
    // their deletion failed because a colleague made a room called Kitchen would be worse than
    // silence.
    const back = resurrectedRooms([deleted('room:k', 'Kitchen')], [room('room:other', 'Kitchen')])
    expect(back).toEqual([])
  })

  it('says nothing at all to a device that deleted nothing', () => {
    // The second scenario: the other person is unaffected. They have no record, so there is
    // nothing to compare and nothing to show - no flag, no suppression, just no input.
    expect(resurrectedRooms([], [room('room:k', 'Cocina')])).toEqual([])
  })

  it('reports several independently', () => {
    const back = resurrectedRooms(
      [deleted('room:a', 'Attic'), deleted('room:b', 'Bathroom')],
      [room('room:a', 'Dachboden')],
    )
    expect(back.map((entry) => entry.deleted.roomId)).toEqual(['room:a'])
  })
})

describe('how long a deletion is worth remembering', () => {
  const now = () => Date.parse('2026-09-02T09:00:00.000Z')
  const daysAgo = (days: number) => new Date(now() - days * 24 * 60 * 60 * 1000).toISOString()

  it('keeps a recent one', () => {
    const records = [deleted('room:k', 'Kitchen', daysAgo(1))]
    expect(worthRemembering(records, [], now)).toHaveLength(1)
  })

  it('forgets one older than the window', () => {
    // A room that has not come back within a month is not going to: the other device would have
    // had to be offline that long with an edit in hand. A list that only grows is the
    // alternative.
    const records = [deleted('room:k', 'Kitchen', daysAgo(DELETION_MEMORY_DAYS + 1))]
    expect(worthRemembering(records, [], now)).toEqual([])
  })

  it('keeps an old one whose room is back, because nobody has been told yet', () => {
    // Expiring this record removes the explanation rather than the problem.
    const records = [deleted('room:k', 'Kitchen', daysAgo(DELETION_MEMORY_DAYS + 1))]
    expect(worthRemembering(records, [room('room:k', 'Cocina')], now)).toHaveLength(1)
  })

  it('keeps one deleted exactly now', () => {
    expect(worthRemembering([deleted('room:k', 'Kitchen', daysAgo(0))], [], now)).toHaveLength(1)
  })
})
