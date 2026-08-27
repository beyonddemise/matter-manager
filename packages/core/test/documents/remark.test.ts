import { describe, expect, it } from 'vitest'
import { DraftError } from '../../src/documents/draft.js'
import { addRemark, remarksNewestFirst } from '../../src/documents/remark.js'
import type { DeviceDocument } from '../../src/documents/types.js'
import type { Remark } from '../../src/sync/merge.js'

const AUTHOR = { sub: 'auth0|abc123', name: 'Stephan' } as const

const remark = (id: string, createdAt: string, text = `remark ${id}`): Remark => ({
  id,
  text,
  authorSub: 'auth0|someone',
  authorName: 'Someone',
  createdAt,
})

const device = (remarks: readonly Remark[] = []): DeviceDocument => ({
  _id: 'device:6ba7b810-9dad-11d1-80b4-00c04fd430c8',
  _rev: '3-abc',
  updatedAt: '2026-08-19T08:00:00.000Z',
  type: 'device',
  name: 'Kitchen ceiling light',
  roomId: 'room:kitchen',
  manualCode: '34970112332',
  installedAt: '2026-08-19',
  addedAt: '2026-08-19T08:00:00.000Z',
  disabled: false,
  remarks,
})

/** A clock whose two halves are distinguishable, so a swapped argument is visible. */
const clock = (now = '2026-08-27T10:00:00.000Z', uuid = 'new-uuid') => ({
  now: () => now,
  uuid: () => uuid,
})

describe('addRemark', () => {
  it('stores the text with the injected timestamp, id and author', () => {
    const updated = addRemark(device(), 'Replaced batteries', AUTHOR, clock())

    expect(updated.remarks).toEqual([
      {
        id: 'new-uuid',
        text: 'Replaced batteries',
        authorSub: 'auth0|abc123',
        authorName: 'Stephan',
        createdAt: '2026-08-27T10:00:00.000Z',
      },
    ])
  })

  it('appends after the remarks already there', () => {
    const existing = remark('aaa', '2026-08-01T10:00:00.000Z')
    const updated = addRemark(device([existing]), 'Second', AUTHOR, clock())

    expect(updated.remarks.map((entry) => entry.text)).toEqual(['remark aaa', 'Second'])
  })

  it('leaves every existing remark the identical object it was', () => {
    const existing = [
      remark('aaa', '2026-08-01T10:00:00.000Z'),
      remark('bbb', '2026-08-02T10:00:00.000Z'),
    ]
    const updated = addRemark(device(existing), 'Third', AUTHOR, clock())

    // Identity, not equality: a remark is an audit record, so "never modified" has to mean
    // the stored object was carried through rather than rebuilt from fields that happened
    // to match.
    expect(updated.remarks[0]).toBe(existing[0])
    expect(updated.remarks[1]).toBe(existing[1])
  })

  it('trims surrounding whitespace from the text', () => {
    const updated = addRemark(device(), '  Replaced batteries \n', AUTHOR, clock())

    expect(updated.remarks[0]?.text).toBe('Replaced batteries')
  })

  it('carries the rest of the device through untouched', () => {
    const original = device()
    const updated = addRemark(original, 'Note', AUTHOR, clock())

    expect(updated.name).toBe(original.name)
    expect(updated.manualCode).toBe(original.manualCode)
    expect(updated.disabled).toBe(false)
    expect(updated._rev).toBe('3-abc')
  })

  it('does not carry the stamp the repository owns', () => {
    const updated = addRemark(device(), 'Note', AUTHOR, clock())

    expect('updatedAt' in updated).toBe(false)
  })

  it.each([
    ['empty', ''],
    ['only spaces', '   '],
    ['only a newline', '\n'],
  ])('refuses a remark that is %s, naming the field', (_case, text) => {
    expect(() => addRemark(device(), text, AUTHOR, clock())).toThrow(DraftError)
    expect(() => addRemark(device(), text, AUTHOR, clock())).toThrow(
      expect.objectContaining({ field: 'remark' }),
    )
  })

  it('writes nothing to the device it was given', () => {
    const original = device([remark('aaa', '2026-08-01T10:00:00.000Z')])
    addRemark(original, 'Note', AUTHOR, clock())

    expect(original.remarks).toHaveLength(1)
  })
})

describe('remarksNewestFirst', () => {
  it('reads the newest remark first', () => {
    const older = remark('aaa', '2026-08-01T10:00:00.000Z')
    const newer = remark('bbb', '2026-08-02T10:00:00.000Z')

    expect(remarksNewestFirst([older, newer])).toEqual([newer, older])
  })

  it('breaks an identical timestamp by id, the reverse of the stored order', () => {
    const same = '2026-08-01T10:00:00.000Z'
    const ordered = remarksNewestFirst([remark('aaa', same), remark('zzz', same)])

    expect(ordered.map((entry) => entry.id)).toEqual(['zzz', 'aaa'])
  })

  it('leaves the array it was given alone', () => {
    const remarks = [
      remark('aaa', '2026-08-01T10:00:00.000Z'),
      remark('bbb', '2026-08-02T10:00:00.000Z'),
    ]
    remarksNewestFirst(remarks)

    expect(remarks.map((entry) => entry.id)).toEqual(['aaa', 'bbb'])
  })

  it('has nothing to order when there are no remarks', () => {
    expect(remarksNewestFirst([])).toEqual([])
  })
})
