import { describe, expect, it } from 'vitest'
import {
  compareRevisions,
  latestRevision,
  mergeDevice,
  mergeRemarks,
  mergeRoom,
  type Remark,
  type Revision,
  type RoomRevision,
  UNASSIGNED_ROOM_PREFIX,
} from '../../src/sync/merge.js'

const remark = (id: string, createdAt: string, text = `remark ${id}`): Remark => ({
  id,
  text,
  authorSub: 'auth0|someone',
  authorName: 'Someone',
  createdAt,
})

/**
 * Typed against the real interfaces rather than inferred from object literals. Inference
 * dropped `_deleted` whenever the other argument lacked it, which hid the property from the
 * compiler in precisely the tests that are about `_deleted`.
 */
type DeviceFixture = Revision & { readonly remarks: readonly Remark[]; readonly name: string }

const device = (
  _rev: string,
  updatedAt: string,
  remarks: readonly Remark[] = [],
  extra: Partial<DeviceFixture> = {},
): DeviceFixture => ({
  _id: 'device:1',
  _rev,
  updatedAt,
  remarks,
  name: 'Kitchen light',
  ...extra,
})

const room = (
  _rev: string,
  updatedAt: string,
  extra: Partial<RoomRevision> = {},
): RoomRevision => ({ _id: 'room:1', _rev, updatedAt, path: 'Ground Floor/Kitchen', ...extra })

/**
 * CouchDB revision ids are `generation-hash`. Comparing them as plain strings is wrong in a
 * way that looks right: `'10-aaa' < '9-zzz'` lexicographically, so generation 10 would lose to
 * generation 9 and the newer write would be discarded.
 *
 * The comparison still has to be a *total* order. ADR 0010 is explicit that an ordering with
 * undefined ties lets replicas pick different winners and never converge, which is worse than
 * picking the wrong winner because there is no longer a single answer to converge on.
 */
describe('compareRevisions', () => {
  it('orders by generation numerically, not lexicographically', () => {
    expect(compareRevisions('10-aaa', '9-zzz')).toBeGreaterThan(0)
    expect(['9-zzz', '10-aaa'].sort(compareRevisions).at(-1)).toBe('10-aaa')
  })

  it('breaks equal generations by hash', () => {
    expect(compareRevisions('3-bbb', '3-aaa')).toBeGreaterThan(0)
    expect(compareRevisions('3-aaa', '3-bbb')).toBeLessThan(0)
  })

  it('reports identical revisions as equal', () => {
    expect(compareRevisions('3-aaa', '3-aaa')).toBe(0)
  })

  it('is antisymmetric, so sorting is stable whichever way the input arrives', () => {
    const pairs: ReadonlyArray<readonly [string, string]> = [
      ['1-a', '2-a'],
      ['10-a', '9-z'],
      ['3-aaa', '3-aab'],
    ]
    for (const [a, b] of pairs) {
      expect(Math.sign(compareRevisions(a, b))).toBe(-Math.sign(compareRevisions(b, a)))
    }
  })

  it('never reports two distinct revisions as equal', () => {
    // A tie between distinct revisions is the failure ADR 0010 warns about: replicas diverge
    // permanently rather than converging on a single answer.
    const revs = ['1-a', '2-a', '10-a', '3-aaa', '3-aab', '9-zzz']
    for (const a of revs) {
      for (const b of revs) {
        if (a !== b) expect(compareRevisions(a, b)).not.toBe(0)
      }
    }
  })
})

/**
 * A revision id that is not `generation-hash` should not reach here. The comparator still
 * needs a defined answer for one, because throwing from inside a sort is a far worse failure
 * than ordering an unexpected value consistently.
 */
describe('compareRevisions tolerates malformed revision ids', () => {
  it.each([
    ['no separator at all', 'abc', '1-a'],
    ['a non-numeric generation', 'x-aaa', '1-a'],
  ])('orders %s below a well-formed one rather than throwing', (_label, bad, good) => {
    expect(() => compareRevisions(bad, good)).not.toThrow()
    expect(compareRevisions(bad, good)).toBeLessThan(0)
  })

  it('still gives a total order among malformed ids', () => {
    expect(compareRevisions('abc', 'abd')).toBeLessThan(0)
    expect(compareRevisions('abc', 'abc')).toBe(0)
  })
})

describe('latestRevision', () => {
  it('refuses an empty list rather than inventing a document', () => {
    // There is no document to return, and any fallback would be fabricated data written back
    // to the database as though it were a merge result.
    expect(() => latestRevision([])).toThrow(RangeError)
    expect(() => latestRevision([])).toThrow(/empty/i)
  })

  it('picks the most recent updatedAt', () => {
    const older = device('1-a', '2026-08-01T00:00:00.000Z')
    const newer = device('1-b', '2026-08-02T00:00:00.000Z')
    expect(latestRevision([older, newer])._rev).toBe('1-b')
  })

  it('breaks equal timestamps by revision, not by argument order', () => {
    const a = device('1-aaa', '2026-08-01T00:00:00.000Z')
    const b = device('1-bbb', '2026-08-01T00:00:00.000Z')
    expect(latestRevision([a, b])._rev).toBe('1-bbb')
    expect(latestRevision([b, a])._rev).toBe('1-bbb')
  })

  it('prefers a later timestamp even when the revision is lower', () => {
    // updatedAt is the primary key; _rev only breaks ties.
    const lowRevLate = device('1-aaa', '2026-08-09T00:00:00.000Z')
    const highRevEarly = device('9-zzz', '2026-08-01T00:00:00.000Z')
    expect(latestRevision([lowRevLate, highRevEarly])._rev).toBe('1-aaa')
  })
})

describe('mergeRemarks', () => {
  const a = remark('aaa', '2026-08-01T10:00:00.000Z')
  const b = remark('bbb', '2026-08-01T11:00:00.000Z')
  const c = remark('ccc', '2026-08-01T12:00:00.000Z')

  it('keeps every remark from every revision exactly once', () => {
    const merged = mergeRemarks([device('1-a', 'x', [a, b]), device('1-b', 'y', [a, c])])
    expect(merged.map((r) => r.id)).toEqual(['aaa', 'bbb', 'ccc'])
  })

  it('orders by createdAt', () => {
    const merged = mergeRemarks([device('1-a', 'x', [c, a]), device('1-b', 'y', [b])])
    expect(merged.map((r) => r.createdAt)).toEqual([
      '2026-08-01T10:00:00.000Z',
      '2026-08-01T11:00:00.000Z',
      '2026-08-01T12:00:00.000Z',
    ])
  })

  it('breaks equal createdAt by remark id', () => {
    const same = '2026-08-01T10:00:00.000Z'
    const merged = mergeRemarks([
      device('1-a', 'x', [remark('zzz', same), remark('aaa', same)]),
      device('1-b', 'y', [remark('mmm', same)]),
    ])
    expect(merged.map((r) => r.id)).toEqual(['aaa', 'mmm', 'zzz'])
  })

  it('gives the same result whatever order the revisions arrive in', () => {
    const one = device('1-a', 'x', [b, a])
    const two = device('1-b', 'y', [c])
    const three = device('1-c', 'z', [a])
    expect(mergeRemarks([one, two, three])).toEqual(mergeRemarks([three, one, two]))
    expect(mergeRemarks([one, two, three])).toEqual(mergeRemarks([two, three, one]))
  })

  it('tolerates revisions with no remarks at all', () => {
    const merged = mergeRemarks([
      device('1-a', 'x', [a]),
      { _id: 'device:1', _rev: '1-b', updatedAt: 'y' },
    ])
    expect(merged.map((r) => r.id)).toEqual(['aaa'])
  })

  it('returns nothing when no revision has remarks', () => {
    expect(mergeRemarks([device('1-a', 'x'), device('1-b', 'y')])).toEqual([])
  })

  /**
   * Remarks are immutable once written, so the same id carrying different text should not
   * happen. It still needs a defined answer: an undefined one lets two replicas keep
   * different text forever, which is the divergence ADR 0010 exists to prevent.
   */
  it('resolves the same id carrying different text by the containing revision', () => {
    const early = device('1-a', '2026-08-01T00:00:00.000Z', [remark('aaa', 'T', 'first text')])
    const late = device('1-b', '2026-08-02T00:00:00.000Z', [remark('aaa', 'T', 'second text')])

    expect(mergeRemarks([early, late])[0]?.text).toBe('second text')
    expect(mergeRemarks([late, early])[0]?.text).toBe('second text')
  })
})

describe('mergeDevice', () => {
  const a = remark('aaa', '2026-08-01T10:00:00.000Z')
  const b = remark('bbb', '2026-08-01T11:00:00.000Z')
  const c = remark('ccc', '2026-08-01T12:00:00.000Z')

  it('unions the remarks and takes scalars from the latest revision', () => {
    const winner = device('1-a', '2026-08-01T00:00:00.000Z', [a, b], { name: 'Old name' })
    const other = device('1-b', '2026-08-02T00:00:00.000Z', [a, c], { name: 'New name' })

    const merged = mergeDevice(winner, [other])

    expect(merged.name).toBe('New name')
    expect(merged.remarks.map((r) => r.id)).toEqual(['aaa', 'bbb', 'ccc'])
  })

  it('takes the scalar from the higher revision when timestamps are equal', () => {
    const same = '2026-08-01T00:00:00.000Z'
    const low = device('1-aaa', same, [], { name: 'Low' })
    const high = device('1-bbb', same, [], { name: 'High' })

    expect(mergeDevice(low, [high]).name).toBe('High')
    expect(mergeDevice(high, [low]).name).toBe('High')
  })

  /**
   * The requirement from ADR 0010: the merge is a pure function of the *set* of conflicting
   * revisions. Which one CouchDB happened to name the winner must not change the answer, or
   * two replicas merging the same conflict reach different results and never converge.
   */
  it('gives an identical result for every permutation of the same revisions', () => {
    const one = device('1-a', '2026-08-01T00:00:00.000Z', [a], { name: 'One' })
    const two = device('2-b', '2026-08-02T00:00:00.000Z', [b], { name: 'Two' })
    const three = device('1-c', '2026-08-01T00:00:00.000Z', [c], { name: 'Three' })

    const permutations = [
      mergeDevice(one, [two, three]),
      mergeDevice(one, [three, two]),
      mergeDevice(two, [one, three]),
      mergeDevice(two, [three, one]),
      mergeDevice(three, [one, two]),
      mergeDevice(three, [two, one]),
    ]
    for (const result of permutations) expect(result).toEqual(permutations[0])
  })

  it('is idempotent: merging a merged result changes nothing', () => {
    const one = device('1-a', '2026-08-01T00:00:00.000Z', [a])
    const two = device('2-b', '2026-08-02T00:00:00.000Z', [b])
    const once = mergeDevice(one, [two])
    expect(mergeDevice(once, [])).toEqual(once)
  })

  it('returns the winner unchanged when there is nothing to merge', () => {
    const only = device('1-a', '2026-08-01T00:00:00.000Z', [a])
    expect(mergeDevice(only, [])).toEqual(only)
  })

  it('does not mutate its inputs', () => {
    const winner = device('1-a', '2026-08-01T00:00:00.000Z', [a])
    const other = device('1-b', '2026-08-02T00:00:00.000Z', [b])
    const snapshot = JSON.stringify([winner, other])

    mergeDevice(winner, [other])

    expect(JSON.stringify([winner, other])).toBe(snapshot)
  })
})

/**
 * ADR 0010: a room deleted on one replica while a device still points at it must not orphan
 * that device. The room comes back as `Unassigned/<old path>` so the device stays findable and
 * the loss is visible rather than silent.
 */
describe('mergeRoom', () => {
  it('takes the path from the latest revision when nothing is deleted', () => {
    const older = room('1-a', '2026-08-01T00:00:00.000Z', { path: 'Ground Floor/Kitchen' })
    const newer = room('1-b', '2026-08-02T00:00:00.000Z', { path: 'Ground Floor/Küche' })

    expect(mergeRoom(older, [newer], { hasLiveDevices: true }).path).toBe('Ground Floor/Küche')
  })

  it('restores a deleted room that devices still reference', () => {
    const deleted = room('2-a', '2026-08-02T00:00:00.000Z', { _deleted: true })
    const live = room('1-b', '2026-08-01T00:00:00.000Z', { path: 'Ground Floor/Kitchen' })

    const merged = mergeRoom(deleted, [live], { hasLiveDevices: true })

    expect(merged.path).toBe(`${UNASSIGNED_ROOM_PREFIX}/Ground Floor/Kitchen`)
    expect(merged._deleted).toBeFalsy()
  })

  it('keeps the room id, which is how the device still reaches it', () => {
    // Devices reference rooms by id, so preserving the id is what makes the device
    // un-orphaned. A new id would leave the device pointing at nothing.
    const deleted = room('2-a', '2026-08-02T00:00:00.000Z', { _deleted: true })
    const live = room('1-b', '2026-08-01T00:00:00.000Z', { path: 'Ground Floor/Kitchen' })

    expect(mergeRoom(deleted, [live], { hasLiveDevices: true })._id).toBe('room:1')
  })

  it('lets a deleted room stay deleted when no device references it', () => {
    const deleted = room('2-a', '2026-08-02T00:00:00.000Z', { _deleted: true })
    const live = room('1-b', '2026-08-01T00:00:00.000Z', { path: 'Ground Floor/Kitchen' })

    expect(mergeRoom(deleted, [live], { hasLiveDevices: false })._deleted).toBe(true)
  })

  it('does not re-prefix a room that is already unassigned', () => {
    // Otherwise a room deleted twice becomes Unassigned/Unassigned/... and the name grows
    // every time it happens.
    const deleted = room('3-a', '2026-08-03T00:00:00.000Z', { _deleted: true })
    const live = room('2-b', '2026-08-02T00:00:00.000Z', {
      path: `${UNASSIGNED_ROOM_PREFIX}/Ground Floor/Kitchen`,
    })

    expect(mergeRoom(deleted, [live], { hasLiveDevices: true }).path).toBe(
      `${UNASSIGNED_ROOM_PREFIX}/Ground Floor/Kitchen`,
    )
  })

  it('takes the old path from the latest revision that still has one', () => {
    const deleted = room('3-a', '2026-08-03T00:00:00.000Z', { _deleted: true })
    const recent = room('2-b', '2026-08-02T00:00:00.000Z', { path: 'Ground Floor/Utility' })
    const ancient = room('1-c', '2026-08-01T00:00:00.000Z', { path: 'Ground Floor/Kitchen' })

    expect(mergeRoom(deleted, [ancient, recent], { hasLiveDevices: true }).path).toBe(
      `${UNASSIGNED_ROOM_PREFIX}/Ground Floor/Utility`,
    )
  })

  it('leaves a room deleted when no revision remembers its path', () => {
    // A room whose name is unrecoverable cannot be meaningfully resurrected. Inventing one
    // would put a room in the list that nobody created; leaving it deleted at least keeps
    // the loss visible where the device's missing room is.
    const deleted = {
      _id: 'room:1',
      _rev: '2-a',
      updatedAt: '2026-08-02T00:00:00.000Z',
      _deleted: true,
    }
    const alsoDeleted = {
      _id: 'room:1',
      _rev: '1-b',
      updatedAt: '2026-08-01T00:00:00.000Z',
      _deleted: true,
    }

    expect(mergeRoom(deleted, [alsoDeleted], { hasLiveDevices: true })._deleted).toBe(true)
  })

  it('gives an identical result for every permutation', () => {
    const deleted = room('3-a', '2026-08-03T00:00:00.000Z', { _deleted: true })
    const recent = room('2-b', '2026-08-02T00:00:00.000Z', { path: 'Ground Floor/Utility' })
    const ancient = room('1-c', '2026-08-01T00:00:00.000Z', { path: 'Ground Floor/Kitchen' })
    const options = { hasLiveDevices: true }

    const results = [
      mergeRoom(deleted, [recent, ancient], options),
      mergeRoom(recent, [deleted, ancient], options),
      mergeRoom(ancient, [deleted, recent], options),
    ]
    for (const result of results) expect(result).toEqual(results[0])
  })

  it('leaves a live room untouched when it is the only revision', () => {
    const only = room('1-a', '2026-08-01T00:00:00.000Z')
    expect(mergeRoom(only, [], { hasLiveDevices: true })).toEqual(only)
  })
})

/**
 * The property the whole module exists to guarantee. Anything not carried in the documents -
 * local time, arrival order, which replica ran the merge - breaks convergence, and the
 * symptom is two replicas that disagree permanently rather than an error anyone can see.
 */
describe('the merge consults nothing outside the documents', () => {
  it('produces byte-identical output across repeated runs', () => {
    const one = device('1-a', '2026-08-01T00:00:00.000Z', [remark('aaa', '2026-08-01T10:00:00Z')])
    const two = device('2-b', '2026-08-02T00:00:00.000Z', [remark('bbb', '2026-08-01T11:00:00Z')])

    const results = Array.from({ length: 5 }, () => JSON.stringify(mergeDevice(one, [two])))
    expect(new Set(results).size).toBe(1)
  })

  it('does not depend on the current time', () => {
    const one = device('1-a', '2099-01-01T00:00:00.000Z', [])
    const two = device('2-b', '1999-01-01T00:00:00.000Z', [], { name: 'Ancient' })

    // A revision timestamped in the future still wins: the rule is "latest updatedAt",
    // not "latest that is not in the future".
    expect(mergeDevice(two, [one])._rev).toBe('1-a')
  })
})
