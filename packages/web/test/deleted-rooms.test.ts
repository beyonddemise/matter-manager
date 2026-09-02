import type { RoomDocument } from '@matter-manager/core'
import { describe, expect, it } from 'vitest'
import {
  forgetDeletion,
  readDeletedRooms,
  rememberDeletion,
  writeDeletedRooms,
} from '../src/deleted-rooms.js'

/**
 * The record of what this device deleted (#125).
 *
 * Local to the browser and never replicated: it answers "did *I* delete this?", and a record
 * that travelled would answer it for everybody — including the person whose rename won, who has
 * nothing to be told.
 */

const storage = (seed: Record<string, string> = {}) => {
  const held = new Map(Object.entries(seed))
  return {
    getItem: (key: string) => held.get(key) ?? null,
    setItem: (key: string, value: string) => void held.set(key, value),
    held,
  }
}

const room = (id: string, path: string): RoomDocument => ({
  _id: id,
  _rev: '1-a',
  updatedAt: '2026-09-02T09:00:00.000Z',
  type: 'room',
  path,
})

const now = () => Date.parse('2026-09-02T09:00:00.000Z')

describe('remembering what this device deleted', () => {
  it('reads back what was written', () => {
    const local = storage()
    rememberDeletion(() => local, 'project_local', room('room:k', 'Kitchen'), [], now)

    expect(readDeletedRooms(() => local, 'project_local').map((r) => r.path)).toEqual(['Kitchen'])
  })

  it('keeps each project’s deletions apart', () => {
    // Room ids are per project. One shared list would compare this project's rooms against
    // another's deletions - ids that can never match, so it would report nothing rather than
    // something wrong. Keyed anyway, because "wrong harmlessly" is not worth relying on.
    const local = storage()
    rememberDeletion(() => local, 'project_a', room('room:k', 'Kitchen'), [], now)

    expect(readDeletedRooms(() => local, 'project_b')).toEqual([])
  })

  it('records a room only once, however often it is deleted', () => {
    const local = storage()
    rememberDeletion(() => local, 'project_local', room('room:k', 'Kitchen'), [], now)
    rememberDeletion(() => local, 'project_local', room('room:k', 'Kitchen'), [], now)

    expect(readDeletedRooms(() => local, 'project_local')).toHaveLength(1)
  })

  it('forgets one when the reader has been told', () => {
    const local = storage()
    rememberDeletion(() => local, 'project_local', room('room:k', 'Kitchen'), [], now)
    forgetDeletion(() => local, 'project_local', 'room:k')

    expect(readDeletedRooms(() => local, 'project_local')).toEqual([])
  })
})

describe('a stored value nobody wrote on purpose', () => {
  it('ignores JSON that will not parse', () => {
    const local = storage({ 'matter-manager.deleted-rooms.project_local': 'not json' })
    expect(readDeletedRooms(() => local, 'project_local')).toEqual([])
  })

  it('ignores a value that is not a list', () => {
    const local = storage({ 'matter-manager.deleted-rooms.project_local': '{"roomId":"x"}' })
    expect(readDeletedRooms(() => local, 'project_local')).toEqual([])
  })

  it('drops an entry missing the fields it is read for', () => {
    // An entry from an older build would otherwise reach `resurrectedRooms` and match an id of
    // `undefined` against a room that has none.
    const local = storage({
      'matter-manager.deleted-rooms.project_local': JSON.stringify([
        { roomId: 'room:k', path: 'Kitchen', deletedAt: '2026-09-02T09:00:00.000Z' },
        { roomId: 'room:broken' },
        null,
        'nonsense',
      ]),
    })

    expect(readDeletedRooms(() => local, 'project_local').map((r) => r.roomId)).toEqual(['room:k'])
  })

  it('survives storage that refuses to be read', () => {
    // Not knowing what was deleted costs an explanation, never data.
    expect(
      readDeletedRooms(() => {
        throw new DOMException('denied', 'SecurityError')
      }, 'project_local'),
    ).toEqual([])
  })

  it('survives storage that refuses to be written', () => {
    expect(() =>
      writeDeletedRooms(
        () => {
          throw new DOMException('denied', 'SecurityError')
        },
        'project_local',
        [],
      ),
    ).not.toThrow()
  })
})
