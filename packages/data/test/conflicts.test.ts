import {
  addRemark,
  type DeviceDocument,
  documentId,
  type RoomDocument,
  type Unsaved,
} from '@matter-manager/core'
import { beforeEach, describe, expect, it } from 'vitest'
import { type ProjectRepositories, projectRepositories } from '../src/index.js'
import {
  fixedClock,
  type Replicas,
  reconnect,
  replicas,
  syncOnce,
} from './support/memory-database.js'

/**
 * The scenarios of M5-6, against real replication.
 *
 * Three in-memory databases and PouchDB's own replication protocol, so every conflict here is
 * produced the way a real one is: two writes committed independently, discovered later through
 * a server neither device talked to the other through. A hand-built `_conflicts` array would
 * make these assertions about the fixture rather than about the code.
 *
 * The merge *decisions* are not tested here — they are pure functions with exhaustive cases in
 * `core/test/sync/merge.test.ts`. What is tested here is that they are reached at all, that
 * their result is written, and that the losing revisions stop existing.
 */

const KITCHEN = documentId('room', '3fa85f64-5717-4562-b3fc-2c963f66afa6')
const LAMP = documentId('device', '6ba7b810-9dad-11d1-80b4-00c04fd430c8')

const lamp = (): Unsaved<DeviceDocument> => ({
  _id: LAMP,
  type: 'device',
  name: 'Kitchen ceiling light',
  roomId: KITCHEN,
  manualCode: '34970112332',
  installedAt: '2026-08-19',
  addedAt: '2026-08-19T08:00:00.000Z',
  disabled: false,
  remarks: [],
})

const kitchen = (): Unsaved<RoomDocument> => ({
  _id: KITCHEN,
  type: 'room',
  path: 'Ground Floor/Kitchen',
})

/** A uuid source that counts, so a remark id in a failure message says where it came from. */
const uuids = (prefix: string): (() => string) => {
  let index = 0
  return () => {
    index += 1
    return `${prefix}-remark-${index}`
  }
}

/** Adding a remark, as the application does it: plan in `core`, write through the repository. */
const remark = async (
  repositories: ProjectRepositories,
  text: string,
  author: string,
  at: string,
): Promise<void> => {
  const device = await repositories.devices.get(LAMP)
  if (device === undefined) throw new Error('the device should be here')
  await repositories.devices.save(
    addRemark(
      device,
      text,
      { sub: `sub-${author.toLowerCase()}`, name: author },
      { uuid: uuids(author.toLowerCase()), now: () => at },
    ),
  )
}

/** Renaming, likewise. */
const rename = async (repositories: ProjectRepositories, name: string): Promise<void> => {
  const device = await repositories.devices.get(LAMP)
  if (device === undefined) throw new Error('the device should be here')
  await repositories.devices.save({ ...device, name })
}

/** The repositories one device would have, with its own clock. */
const on = (database: PouchDB.Database, ...timestamps: readonly string[]): ProjectRepositories =>
  projectRepositories(database, fixedClock(...timestamps))

/** Reads the stored document, conflicts included, without going through a repository. */
const stored = async (
  database: PouchDB.Database,
  id: string,
): Promise<{
  readonly _rev: string
  readonly name?: string
  readonly _conflicts?: readonly string[]
}> =>
  (await database.get(id, { conflicts: true })) as unknown as {
    readonly _rev: string
    readonly name?: string
    readonly _conflicts?: readonly string[]
  }

let three: Replicas

beforeEach(() => {
  three = replicas()
})

/** Puts the same device and room on both devices, through the server, before anyone edits. */
async function shared(): Promise<void> {
  const first = on(three.deviceA, '2026-08-20T08:00:00.000Z')
  await first.devices.save(lamp())
  await first.rooms.save(kitchen())
  await syncOnce(three.deviceA, three.server)
  await syncOnce(three.deviceB, three.server)
}

describe('concurrent remarks all survive', () => {
  beforeEach(shared)

  it('keeps both remarks, attributed, in chronological order', async () => {
    const a = on(three.deviceA, '2026-08-20T10:00:00.000Z')
    const b = on(three.deviceB, '2026-08-20T09:00:00.000Z')

    // Both offline: neither replicates, so neither write can know about the other.
    await remark(a, 'Behind the panel', 'Anna', '2026-08-20T10:00:00.000Z')
    await remark(b, 'Flaky since the firmware update', 'Ben', '2026-08-20T09:00:00.000Z')

    await reconnect(three)

    const merged = await a.devices.get(LAMP)
    expect(merged?.remarks.map((entry) => entry.text)).toEqual([
      'Flaky since the firmware update',
      'Behind the panel',
    ])
    // Attributed, because a merged history where the names were lost reads as one person
    // contradicting themselves.
    expect(merged?.remarks.map((entry) => entry.authorName)).toEqual(['Ben', 'Anna'])
  })

  it('reaches the same merged document on the other device, independently', async () => {
    const a = on(three.deviceA, '2026-08-20T10:00:00.000Z')
    const b = on(three.deviceB, '2026-08-20T09:00:00.000Z')

    await remark(a, 'Behind the panel', 'Anna', '2026-08-20T10:00:00.000Z')
    await remark(b, 'Flaky', 'Ben', '2026-08-20T09:00:00.000Z')

    await reconnect(three)

    // Each device resolves on its own, with no coordination and in either order. That is what
    // ADR 0010 requires: a pure function of the set of revisions, computable anywhere.
    const onA = await a.devices.get(LAMP)
    const onB = await b.devices.get(LAMP)

    // Both remarks, and not merely "the same answer" — two devices that both discarded the
    // same remark would also be equal, and equality alone would pass with no merge at all.
    expect(onA?.remarks).toHaveLength(2)
    expect(onA).toEqual(onB)
  })
})

describe('concurrent field edits resolve deterministically', () => {
  beforeEach(shared)

  it('keeps the later write on both devices, where CouchDB alone would not', async () => {
    const a = on(three.deviceA, '2026-08-20T10:00:00.000Z')
    const b = on(three.deviceB, '2026-08-20T09:00:00.000Z')

    await rename(a, 'Hall light')
    await rename(b, 'Kitchen lamp')
    await reconnect(three)

    // The premise of this test, asserted rather than assumed. CouchDB's own winner is the
    // highest revision hash at the highest generation — nothing to do with time — and with
    // these two names it lands on the EARLIER write. Without that check the test would still
    // pass if the merge were deleted, on any fixture where CouchDB happened to guess right,
    // and nothing would say so. If a future PouchDB changes the hashing, this fails loudly
    // instead of quietly proving nothing.
    expect((await stored(three.deviceA, LAMP)).name).toBe('Kitchen lamp')

    expect((await a.devices.get(LAMP))?.name).toBe('Hall light')
    expect((await b.devices.get(LAMP))?.name).toBe('Hall light')
  })

  it('agrees even when both clocks read exactly the same instant', async () => {
    // The case the tie-breaker exists for. `updatedAt` alone is not a total order, and two
    // replicas that broke this tie differently would never converge — each internally
    // consistent, permanently disagreeing, with no further replication able to repair it.
    const sameInstant = '2026-08-20T10:00:00.000Z'
    const a = on(three.deviceA, sameInstant)
    const b = on(three.deviceB, sameInstant)

    // A remark each as well as the rename, so that a device which resolved nothing cannot
    // reach the same answer as one that did.
    await remark(a, 'Anna was here', 'Anna', sameInstant)
    await rename(a, 'Hall light')
    await remark(b, 'Ben was here', 'Ben', sameInstant)
    await rename(b, 'Kitchen lamp')

    await reconnect(three)

    const onA = await a.devices.get(LAMP)
    const onB = await b.devices.get(LAMP)

    expect(onA?.remarks).toHaveLength(2)
    expect(onA).toEqual(onB)
    expect(onA?.updatedAt).toBe(sameInstant)
  })
})

describe('conflict revisions do not accumulate', () => {
  beforeEach(shared)

  it('leaves _conflicts empty everywhere after the merge', async () => {
    const a = on(three.deviceA, '2026-08-20T10:00:00.000Z')
    const b = on(three.deviceB, '2026-08-20T09:00:00.000Z')

    await remark(a, 'One', 'Anna', '2026-08-20T10:00:00.000Z')
    await remark(b, 'Two', 'Ben', '2026-08-20T09:00:00.000Z')
    await reconnect(three)

    // There is genuinely a conflict to remove. Asserting its absence afterwards means nothing
    // unless it was present first.
    expect((await stored(three.deviceA, LAMP))._conflicts).toHaveLength(1)

    await a.devices.get(LAMP)
    await b.devices.get(LAMP)
    await reconnect(three)

    // All three, because a merge that pruned only locally leaves the server handing the same
    // conflict back on the next replication, forever.
    expect((await stored(three.deviceA, LAMP))._conflicts).toBeUndefined()
    expect((await stored(three.deviceB, LAMP))._conflicts).toBeUndefined()
    expect((await stored(three.server, LAMP))._conflicts).toBeUndefined()
  })

  it('writes no new revision when the merge says what the winner already said', async () => {
    // Both renamed, nobody added anything, and CouchDB's winner is already the later write —
    // so the merged document and the stored one are the same document. Writing it anyway would
    // put a fresh revision on every device that reads a resolved conflict, and replicate it,
    // for no change at all.
    const a = on(three.deviceA, '2026-08-20T10:00:00.000Z')
    const b = on(three.deviceB, '2026-08-20T09:00:00.000Z')

    await rename(a, 'Ceiling light')
    await rename(b, 'Kitchen lamp')
    await reconnect(three)

    const before = await stored(three.deviceA, LAMP)
    expect(before.name).toBe('Ceiling light')
    expect(before._conflicts).toHaveLength(1)

    expect((await a.devices.get(LAMP))?.name).toBe('Ceiling light')

    const after = await stored(three.deviceA, LAMP)
    expect(after._rev).toBe(before._rev)
    expect(after._conflicts).toBeUndefined()
  })

  it('never hands _conflicts to a caller', async () => {
    // `_conflicts` is a read-time annotation, not a field of the document. Returning one would
    // put it straight back into the next `save`, and an unrecognised underscore field is a
    // `doc_validation` failure — a write that breaks only for documents that were once in
    // conflict, which is as narrow a reproduction as a bug can have.
    const a = on(three.deviceA, '2026-08-20T10:00:00.000Z')
    const b = on(three.deviceB, '2026-08-20T09:00:00.000Z')

    await remark(a, 'One', 'Anna', '2026-08-20T10:00:00.000Z')
    await remark(b, 'Two', 'Ben', '2026-08-20T09:00:00.000Z')
    await reconnect(three)

    expect(await a.devices.get(LAMP)).not.toHaveProperty('_conflicts')
    expect(await a.devices.list()).not.toContainEqual(
      expect.objectContaining({ _conflicts: expect.anything() }),
    )

    // And the document that comes back can be written again, which is the thing that would
    // actually break. `_rev` is current here because the read resolved the conflict.
    const resolved = await a.devices.get(LAMP)
    if (resolved === undefined) throw new Error('the device should be here')
    await expect(a.devices.save(resolved)).resolves.toBeDefined()
  })

  it('never hands one back when the merge chose the winning revision', async () => {
    // The case the test above cannot reach. When the merge takes its answer from the *winner*,
    // the object it returns is the very one the annotation was read onto — so stripping it
    // anywhere except the boundary leaks it, and only here. Two renames with no remarks: the
    // merge picks the winner unchanged and writes nothing at all.
    const a = on(three.deviceA, '2026-08-20T10:00:00.000Z')
    const b = on(three.deviceB, '2026-08-20T09:00:00.000Z')

    await rename(a, 'Ceiling light')
    await rename(b, 'Kitchen lamp')
    await reconnect(three)
    expect((await stored(three.deviceA, LAMP))._conflicts).toHaveLength(1)

    expect(await a.devices.get(LAMP)).not.toHaveProperty('_conflicts')
  })
})

describe('every read resolves, not only the one that fetches by id', () => {
  beforeEach(shared)

  it('merges a conflicted device reached through the list', async () => {
    // The device list is the screen this application opens on, so it is the read that reaches
    // a freshly replicated conflict first — usually before anybody has opened the device.
    const a = on(three.deviceA, '2026-08-20T10:00:00.000Z')
    const b = on(three.deviceB, '2026-08-20T09:00:00.000Z')

    await remark(a, 'One', 'Anna', '2026-08-20T10:00:00.000Z')
    await remark(b, 'Two', 'Ben', '2026-08-20T09:00:00.000Z')
    await reconnect(three)

    const [listed] = await a.devices.list()

    expect(listed?.remarks).toHaveLength(2)
    expect((await stored(three.deviceA, LAMP))._conflicts).toBeUndefined()
  })

  it('merges a conflicted room, which has its own strategy', async () => {
    // Rooms are not devices: they merge by `path` rather than by unioning anything, and they
    // are wired separately. A resolver attached to devices alone would leave two people who
    // renamed the same room permanently disagreeing about what it is called.
    const a = on(three.deviceA, '2026-08-20T10:00:00.000Z')
    const b = on(three.deviceB, '2026-08-20T09:00:00.000Z')

    const mine = await a.rooms.get(KITCHEN)
    if (mine === undefined) throw new Error('the room should be here')
    await a.rooms.save({ ...mine, path: 'Ground Floor/Kitchenette' })

    const theirs = await b.rooms.get(KITCHEN)
    if (theirs === undefined) throw new Error('the room should be here')
    await b.rooms.save({ ...theirs, path: 'Ground Floor/Kitchen Diner' })

    await reconnect(three)
    expect((await stored(three.deviceA, KITCHEN))._conflicts).toHaveLength(1)

    // The later write, on both devices, and no conflict left behind.
    expect((await a.rooms.get(KITCHEN))?.path).toBe('Ground Floor/Kitchenette')
    expect((await b.rooms.get(KITCHEN))?.path).toBe('Ground Floor/Kitchenette')
    expect((await stored(three.deviceA, KITCHEN))._conflicts).toBeUndefined()
  })
})
