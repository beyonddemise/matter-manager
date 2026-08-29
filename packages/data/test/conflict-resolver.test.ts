import {
  addRemark,
  type DeviceDocument,
  documentId,
  mergeDevice,
  type RoomDocument,
  type Unsaved,
} from '@matter-manager/core'
import { beforeEach, describe, expect, it } from 'vitest'
import { type Conflicted, conflictResolver, watchConflicts } from '../src/conflicts.js'
import { type ProjectRepositories, projectRepositories } from '../src/index.js'
import {
  fixedClock,
  type Replicas,
  reconnect,
  replicas,
  syncOnce,
} from './support/memory-database.js'

/**
 * The mechanism, rather than the scenarios.
 *
 * `conflicts.test.ts` asks whether two people who worked offline both keep their work. This
 * file asks the questions that only show up when something goes wrong at the moment of
 * resolution: a write that loses a race, a prune that fails, two resolutions of the same
 * document at once, and the conflicts no read will ever reach.
 *
 * Failures are injected by **wrapping a real database**, not by replacing it. A fake that
 * returned a conflict would be a fake of the thing under test.
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

/** What each wrapper may intercept. Everything else passes straight through. */
interface Interception {
  /** Called before each `put`; throwing from it fails that write. */
  readonly onPut?: () => void
  /** Called before each `bulkDocs`; throwing from it fails that prune. */
  readonly onBulkDocs?: () => void
}

/**
 * A real database with one or two methods watched.
 *
 * A `Proxy` rather than a hand-written stand-in: every method not named here is the real
 * PouchDB one, so a test that injects a failure into `put` is still exercising real reads,
 * real revision trees and the real change feed.
 */
function watching(database: PouchDB.Database, interception: Interception): PouchDB.Database {
  return new Proxy(database, {
    get(target, property, receiver): unknown {
      if (property === 'put' && interception.onPut !== undefined) {
        return async (...args: unknown[]): Promise<unknown> => {
          interception.onPut?.()
          return (target.put as (...rest: unknown[]) => Promise<unknown>)(...args)
        }
      }
      if (property === 'bulkDocs' && interception.onBulkDocs !== undefined) {
        return async (...args: unknown[]): Promise<unknown> => {
          interception.onBulkDocs?.()
          return (target.bulkDocs as (...rest: unknown[]) => Promise<unknown>)(...args)
        }
      }
      const value = Reflect.get(target, property, receiver) as unknown
      return typeof value === 'function' ? value.bind(target) : value
    },
  }) as PouchDB.Database
}

/** An error shaped the way PouchDB reports a lost race. */
function conflictError(): Error {
  return Object.assign(new Error('Document update conflict'), { status: 409, name: 'conflict' })
}

/** Retries until the assertion holds, for changes that arrive through the change feed. */
async function eventually(check: () => Promise<void>, attempts = 50): Promise<void> {
  for (let remaining = attempts; remaining > 1; remaining -= 1) {
    try {
      await check()
      return
    } catch {
      await new Promise((resume) => setTimeout(resume, 10))
    }
  }
  await check()
}

const on = (database: PouchDB.Database, ...timestamps: readonly string[]): ProjectRepositories =>
  projectRepositories(database, fixedClock(...timestamps))

const stored = async (
  database: PouchDB.Database,
  id: string,
): Promise<{
  readonly _rev: string
  readonly path?: string
  readonly remarks?: readonly { readonly text: string }[]
  readonly _conflicts?: readonly string[]
}> =>
  (await database.get(id, { conflicts: true })) as unknown as {
    readonly _rev: string
    readonly path?: string
    readonly remarks?: readonly { readonly text: string }[]
    readonly _conflicts?: readonly string[]
  }

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
      { sub: `sub-${author}`, name: author },
      { uuid: () => `${author}-1`, now: () => at },
    ),
  )
}

let three: Replicas

beforeEach(async () => {
  three = replicas()
  const first = on(three.deviceA, '2026-08-20T08:00:00.000Z')
  await first.devices.save(lamp())
  await first.rooms.save(kitchen())
  await syncOnce(three.deviceA, three.server)
  await syncOnce(three.deviceB, three.server)
})

/** Both devices add a remark offline, then reconnect. The standard conflict. */
async function conflictingRemarks(): Promise<void> {
  await remark(
    on(three.deviceA, '2026-08-20T10:00:00.000Z'),
    'Anna wrote this',
    'Anna',
    '2026-08-20T10:00:00.000Z',
  )
  await remark(
    on(three.deviceB, '2026-08-20T09:00:00.000Z'),
    'Ben wrote this',
    'Ben',
    '2026-08-20T09:00:00.000Z',
  )
  await reconnect(three)
}

describe('the merged document is written before the losers are removed', () => {
  it('keeps every remark when the prune fails', async () => {
    await conflictingRemarks()

    const database = watching(three.deviceA, {
      onBulkDocs: () => {
        throw new Error('the disk went away')
      },
    })
    const repositories = on(database, '2026-08-20T11:00:00.000Z')

    await expect(repositories.devices.get(LAMP)).rejects.toThrow('the disk went away')

    // The order is the whole assertion. Interrupted here, the merged document already exists
    // and the only cost is a stale conflict that the next read clears. Pruning first would
    // have left this window with the remarks existing *only* in revisions just deleted.
    const survivor = await stored(three.deviceA, LAMP)
    expect(survivor.remarks?.map((entry) => entry.text)).toEqual([
      'Ben wrote this',
      'Anna wrote this',
    ])
    expect(survivor._conflicts).toHaveLength(1)
  })

  it('finishes the job on the next read', async () => {
    await conflictingRemarks()

    let failing = true
    const database = watching(three.deviceA, {
      onBulkDocs: () => {
        if (failing) throw new Error('the disk went away')
      },
    })
    const repositories = on(database, '2026-08-20T11:00:00.000Z')
    await expect(repositories.devices.get(LAMP)).rejects.toThrow()

    failing = false
    const merged = await repositories.devices.get(LAMP)

    expect(merged?.remarks).toHaveLength(2)
    expect((await stored(three.deviceA, LAMP))._conflicts).toBeUndefined()
  })
})

describe('losing a race', () => {
  it('re-reads and merges again when the write is refused', async () => {
    await conflictingRemarks()

    let refusals = 1
    const database = watching(three.deviceA, {
      onPut: () => {
        if (refusals > 0) {
          refusals -= 1
          throw conflictError()
        }
      },
    })

    const merged = await on(database, '2026-08-20T11:00:00.000Z').devices.get(LAMP)

    expect(merged?.remarks).toHaveLength(2)
    expect((await stored(three.deviceA, LAMP))._conflicts).toBeUndefined()
  })

  it('gives up rather than spinning when the write is refused every time', async () => {
    await conflictingRemarks()

    let attempts = 0
    const database = watching(three.deviceA, {
      onPut: () => {
        attempts += 1
        throw conflictError()
      },
    })

    await expect(on(database, '2026-08-20T11:00:00.000Z').devices.get(LAMP)).rejects.toThrow(
      'Document update conflict',
    )
    // Bounded. A resolver that retried forever against a document somebody is editing in a
    // loop would never return, and the caller is a read.
    expect(attempts).toBe(3)
  })

  it('treats an already-deleted losing revision as the outcome it wanted', async () => {
    await conflictingRemarks()

    // Somebody else pruned between this read and the resolution: exactly the race two devices
    // resolving the same conflict at the same moment produce.
    const before = await stored(three.deviceA, LAMP)
    const losers = before._conflicts ?? []
    expect(losers).toHaveLength(1)
    const stale = (await three.deviceA.get(LAMP, {
      conflicts: true,
    })) as unknown as Conflicted<DeviceDocument>
    await three.deviceA.bulkDocs(losers.map((rev) => ({ _id: LAMP, _rev: rev, _deleted: true })))

    await expect(
      conflictResolver(three.deviceA).resolve(stale, mergeDevice),
    ).resolves.toMatchObject({ _id: LAMP })
  })
})

describe('two resolutions of one document', () => {
  it('shares the work instead of racing to write it twice', async () => {
    await conflictingRemarks()

    let writes = 0
    const database = watching(three.deviceA, {
      onPut: () => {
        writes += 1
      },
    })
    const repositories = on(database, '2026-08-20T11:00:00.000Z')

    // A view re-reading while the change feed resolves the same document is not hypothetical;
    // it is what happens the moment replication delivers a conflict to an open list.
    const [first, second] = await Promise.all([
      repositories.devices.get(LAMP),
      repositories.devices.get(LAMP),
    ])

    expect(writes).toBe(1)
    expect(first).toEqual(second)
    expect(first?.remarks).toHaveLength(2)
  })

  it('does not remember a failed resolution', async () => {
    await conflictingRemarks()

    let failing = true
    const database = watching(three.deviceA, {
      onPut: () => {
        if (failing) throw new Error('the disk went away')
      },
    })
    const repositories = on(database, '2026-08-20T11:00:00.000Z')

    await expect(repositories.devices.get(LAMP)).rejects.toThrow()
    failing = false

    // A resolution remembered by id would hand this caller the earlier failure forever, and
    // the document would stay unmerged until the page was reloaded.
    expect((await repositories.devices.get(LAMP))?.remarks).toHaveLength(2)
  })
})

describe('the change feed', () => {
  it('resolves a conflict nobody has read', async () => {
    const repositories = on(three.deviceA, '2026-08-20T11:00:00.000Z')
    const watch = repositories.watchConflicts()

    try {
      await conflictingRemarks()

      // Nothing reads the device. ADR 0010 asks for resolution on every change event because a
      // conflict arrives by replication, on a device whose user may be doing nothing at all.
      await eventually(async () => {
        expect((await stored(three.deviceA, LAMP))._conflicts).toBeUndefined()
      })
      expect((await stored(three.deviceA, LAMP)).remarks).toHaveLength(2)
    } finally {
      watch.cancel()
    }
  })

  it('stops when cancelled', async () => {
    const repositories = on(three.deviceA, '2026-08-20T11:00:00.000Z')
    repositories.watchConflicts().cancel()

    await conflictingRemarks()
    await new Promise((resume) => setTimeout(resume, 50))

    expect((await stored(three.deviceA, LAMP))._conflicts).toHaveLength(1)
  })

  it('reports a failed resolution rather than swallowing it', async () => {
    const failures: unknown[] = []
    const database = watching(three.deviceA, {
      onBulkDocs: () => {
        throw new Error('the disk went away')
      },
    })
    const watch = on(database, '2026-08-20T11:00:00.000Z').watchConflicts((error) => {
      failures.push(error)
    })

    try {
      await conflictingRemarks()
      // Unreported, this is a device that quietly stops resolving conflicts and looks exactly
      // like one that has none.
      //
      // "At least one" rather than exactly one: the feed reports the local write and the
      // revision that arrives by replication as two changes, and both find the same conflict.
      // Pinning the count would be asserting how many times PouchDB happens to say something.
      await eventually(async () => {
        expect(failures.length).toBeGreaterThan(0)
      })
      expect(failures.every((error) => error instanceof Error)).toBe(true)
    } finally {
      watch.cancel()
    }
  })

  it('offers only the changes that have conflicts', async () => {
    // Counted at the callback rather than at the database, because a resolver asked about an
    // unconflicted document correctly does nothing — so "no write happened" would pass whether
    // the filter existed or not, and the cost this guard exists to avoid is the asking.
    const offered: string[] = []
    const watch = watchConflicts(three.deviceA, {
      onConflicted: async (document) => {
        offered.push(document._id)
      },
    })

    try {
      await remark(
        on(three.deviceA, '2026-08-20T11:00:00.000Z'),
        'Ordinary',
        'Anna',
        '2026-08-20T11:00:00.000Z',
      )
      await new Promise((resume) => setTimeout(resume, 50))
      expect(offered).toEqual([])

      await conflictingRemarks()
      await eventually(async () => {
        expect(offered).toContain(LAMP)
      })
    } finally {
      watch.cancel()
    }
  })

  it('starts from now rather than re-reading the whole database', async () => {
    await conflictingRemarks()

    const offered: string[] = []
    const watch = watchConflicts(three.deviceA, {
      onConflicted: async (document) => {
        offered.push(document._id)
      },
    })

    try {
      await new Promise((resume) => setTimeout(resume, 50))

      // The backlog is the read path's job — every list and every open resolves what it
      // touches, and the device list is the screen this application opens on. Replaying the
      // whole change log with `include_docs` at every start would re-read the entire database
      // on the devices least able to afford it, to find conflicts a read will reach anyway.
      expect(offered).toEqual([])
    } finally {
      watch.cancel()
    }
  })

  it('can be cancelled twice', async () => {
    // Cancelling is what a page teardown and a sign-out both do, and they can both happen.
    const watch = on(three.deviceA, '2026-08-20T11:00:00.000Z').watchConflicts()
    watch.cancel()
    expect(() => {
      watch.cancel()
    }).not.toThrow()
  })

  it('writes nothing for an ordinary change', async () => {
    let writes = 0
    const database = watching(three.deviceA, {
      onPut: () => {
        writes += 1
      },
    })
    const repositories = on(database, '2026-08-20T11:00:00.000Z')
    const watch = repositories.watchConflicts()

    try {
      await remark(repositories, 'Just a remark', 'Anna', '2026-08-20T11:00:00.000Z')
      await new Promise((resume) => setTimeout(resume, 50))

      // One write: the remark itself. A watch that resolved every change would rewrite every
      // document that was ever touched, and replicate each rewrite.
      expect(writes).toBe(1)
    } finally {
      watch.cancel()
    }
  })
})

describe('a deletion racing an edit', () => {
  /**
   * The room is deleted on one device and renamed on the other, with a device still in it.
   *
   * The deletion is made the **higher generation** deliberately, so that the outcome below
   * cannot be explained by "the other one was newer". It is not: a deleted leaf loses to a live
   * one whatever its generation.
   */
  const deletedOnALiveOnB = async (): Promise<void> => {
    const a = on(three.deviceA, '2026-08-20T10:00:00.000Z', '2026-08-20T11:00:00.000Z')
    const b = on(three.deviceB, '2026-08-20T09:00:00.000Z')

    const room = await a.rooms.get(KITCHEN)
    if (room === undefined) throw new Error('the room should be here')
    const renamed = await a.rooms.save({ ...room, path: 'Ground Floor/Kitchenette' })
    await a.rooms.remove(renamed)

    const theirs = await b.rooms.get(KITCHEN)
    if (theirs === undefined) throw new Error('the room should be here')
    await b.rooms.save({ ...theirs, path: 'Ground Floor/Kitchen Diner' })
  }

  it('is not reported as a conflict at all, and the edit survives', async () => {
    await deletedOnALiveOnB()
    await reconnect(three)

    const a = on(three.deviceA, '2026-08-20T12:00:00.000Z')

    // Verified against PouchDB rather than assumed, because it is surprising twice over: a
    // deleted leaf loses to a live one **regardless of generation**, and a deleted losing
    // branch is not listed in `_conflicts` at all — CouchDB puts those in `_deleted_conflicts`,
    // which PouchDB does not implement. Only `get(id, { open_revs: 'all' })` can see it, and
    // that is a second read of every document on every list.
    //
    // So there is nothing here for `resolve` to do, and `mergeRoom`'s resurrection branch
    // cannot be reached through this mechanism: a deleted revision wins only when *every*
    // branch is deleted, and then there is no path left to resurrect. See `docs/tasks/todo-53.md`.
    const winner = await stored(three.deviceA, KITCHEN)
    expect(winner._conflicts).toBeUndefined()
    expect(winner.path).toBe('Ground Floor/Kitchen Diner')

    // Which is the safe direction, and the reason this is documented rather than worked around:
    // the deletion is discarded, nothing anybody typed is lost, and the device still has a room
    // to be in. A resolution that let the deletion win would have to resurrect the room anyway.
    expect((await a.rooms.get(KITCHEN))?.path).toBe('Ground Floor/Kitchen Diner')
    expect((await a.devices.get(LAMP))?.roomId).toBe(KITCHEN)
  })

  it('leaves the same room on both devices', async () => {
    await deletedOnALiveOnB()
    await reconnect(three)

    // Convergence is the part that still has to hold. Two devices disagreeing about whether a
    // room exists is the failure this milestone is about, whichever way the disagreement went.
    expect(await on(three.deviceA, '2026-08-20T12:00:00.000Z').rooms.list()).toEqual(
      await on(three.deviceB, '2026-08-20T12:00:00.000Z').rooms.list(),
    )
  })
})
