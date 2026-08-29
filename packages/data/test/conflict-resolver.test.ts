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
  readonly onPut?: () => void | Promise<void>
  /** Called before each `bulkDocs`; throwing from it fails that prune. */
  readonly onBulkDocs?: () => void | Promise<void>
  /** Replaces what `bulkDocs` answers, without changing what it did. */
  readonly bulkDocsResult?: (results: unknown) => unknown
  /** Handed each change feed as it is opened. */
  readonly onChanges?: (feed: { emit(event: string, payload: unknown): void }) => void
  /** Called before each read of one specific revision; throwing from it fails that read. */
  readonly onGetRevision?: () => void
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
          await interception.onPut?.()
          return (target.put as (...rest: unknown[]) => Promise<unknown>)(...args)
        }
      }
      if (
        property === 'bulkDocs' &&
        (interception.onBulkDocs !== undefined || interception.bulkDocsResult !== undefined)
      ) {
        return async (...args: unknown[]): Promise<unknown> => {
          await interception.onBulkDocs?.()
          const results = await (target.bulkDocs as (...rest: unknown[]) => Promise<unknown>)(
            ...args,
          )
          return interception.bulkDocsResult?.(results) ?? results
        }
      }
      if (property === 'get' && interception.onGetRevision !== undefined) {
        return async (id: string, options?: { rev?: string }): Promise<unknown> => {
          // Only the by-revision form. The document's own read has to keep working, or the
          // test would be about a missing document rather than a missing revision.
          if (options?.rev !== undefined) interception.onGetRevision?.()
          return (target.get as (...rest: unknown[]) => Promise<unknown>)(id, options)
        }
      }
      if (property === 'changes' && interception.onChanges !== undefined) {
        return (...args: unknown[]): unknown => {
          const feed = (target.changes as (...rest: unknown[]) => unknown)(...args)
          interception.onChanges?.(feed as { emit(event: string, payload: unknown): void })
          return feed
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

describe('the document goes away mid-resolution', () => {
  it('does not resurrect a document somebody deleted', async () => {
    await conflictingRemarks()

    const before = await stored(three.deviceA, LAMP)
    const leaves = [before._rev, ...(before._conflicts ?? [])]

    let first = true
    const database = watching(three.deviceA, {
      onPut: async () => {
        if (!first) return
        first = false
        // Deleted between the read and the write — every leaf, so the document is genuinely
        // gone rather than merely down to one branch.
        await three.deviceA.bulkDocs(
          leaves.map((rev) => ({ _id: LAMP, _rev: rev, _deleted: true })),
        )
        throw conflictError()
      },
    })

    // The merge had an answer and does not write it. Re-creating the document here would undo
    // a deletion by way of a conflict resolution, which is not something a user could
    // understand or reverse.
    const returned = await on(database, '2026-08-20T11:00:00.000Z').devices.get(LAMP)

    await expect(three.deviceA.get(LAMP)).rejects.toMatchObject({ status: 404 })

    // The caller gets the snapshot it read, which is what any read that raced a delete would
    // return — unmerged, because the merge was abandoned rather than applied.
    expect(returned?.remarks).toHaveLength(1)
  })

  it('stops when the retry finds the conflict already resolved', async () => {
    await conflictingRemarks()

    let first = true
    const database = watching(three.deviceA, {
      onPut: async () => {
        if (!first) return
        first = false
        // The other device got there first: merged, pruned, replicated back. The retry re-reads
        // a document with nothing left to resolve, and must return it rather than merging an
        // empty set of losers onto it.
        await on(three.deviceA, '2026-08-20T10:30:00.000Z').devices.get(LAMP)
        throw conflictError()
      },
    })

    const resolved = await on(database, '2026-08-20T11:00:00.000Z').devices.get(LAMP)

    expect(resolved?.remarks).toHaveLength(2)
    expect((await stored(three.deviceA, LAMP))._conflicts).toBeUndefined()
  })
})

describe('a losing revision that cannot be read', () => {
  it('is a failure, not an answer of "no such document"', async () => {
    await conflictingRemarks()

    const database = watching(three.deviceA, {
      onGetRevision: () => {
        // What a compacted-away revision raises, and what another resolver removing it first
        // would raise once compaction had caught up.
        throw Object.assign(new Error('missing'), { status: 404, name: 'not_found' })
      },
    })

    // The device is right there. Reporting it absent because one of its *old* revisions is
    // absent would empty the catalogue on exactly the databases that have been running longest
    // — and the caller has no way to tell that apart from a device somebody deleted.
    await expect(on(database, '2026-08-20T11:00:00.000Z').devices.get(LAMP)).rejects.toMatchObject({
      status: 404,
    })
  })
})

describe('a prune the database refuses', () => {
  it('is raised rather than leaving the conflict unreported', async () => {
    await conflictingRemarks()

    const database = watching(three.deviceA, {
      // The shape CouchDB returns when `validate_doc_update` rejects a row — which is exactly
      // what `_design/access` does to a writer who has just lost write access. `bulkDocs`
      // reports it per row instead of rejecting, so a resolver that only caught thrown errors
      // would treat this as a successful prune and leave `_conflicts` growing untouched.
      bulkDocsResult: (results) =>
        (results as unknown[]).map(() => ({ error: true, name: 'forbidden', reason: 'read only' })),
    })

    await expect(on(database, '2026-08-20T11:00:00.000Z').devices.get(LAMP)).rejects.toThrow(
      /Losing revisions of .* could not be removed/,
    )
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

  it('resolves a room, which merges by a different rule than a device', async () => {
    // Devices and rooms arrive down one channel and the id is what says which is which. A watch
    // that resolved only devices would leave every room conflict to a read that may not come.
    const a = on(three.deviceA, '2026-08-20T11:00:00.000Z')
    const watch = a.watchConflicts()

    try {
      const mine = await a.rooms.get(KITCHEN)
      if (mine === undefined) throw new Error('the room should be here')
      await a.rooms.save({ ...mine, path: 'Ground Floor/Kitchenette' })

      const b = on(three.deviceB, '2026-08-20T09:00:00.000Z')
      const theirs = await b.rooms.get(KITCHEN)
      if (theirs === undefined) throw new Error('the room should be here')
      await b.rooms.save({ ...theirs, path: 'Ground Floor/Kitchen Diner' })

      await reconnect(three)

      await eventually(async () => {
        expect((await stored(three.deviceA, KITCHEN))._conflicts).toBeUndefined()
      })
      expect((await stored(three.deviceA, KITCHEN)).path).toBe('Ground Floor/Kitchenette')
    } finally {
      watch.cancel()
    }
  })

  it('leaves alone a document this application did not write', async () => {
    // The feed carries whatever is in the database — a design document, something a future
    // version writes, something another tool put there. Guessing a merge strategy for an id
    // whose shape is unknown would be rewriting a stranger's document.
    const foreign = 'note:1'
    await three.deviceA.put({ _id: foreign, text: 'from device A' })
    await three.deviceB.put({ _id: foreign, text: 'from device B' })

    const watch = on(three.deviceA, '2026-08-20T11:00:00.000Z').watchConflicts()
    try {
      await reconnect(three)
      await new Promise((resume) => setTimeout(resume, 50))

      const untouched = await three.deviceA.get(foreign, { conflicts: true })
      expect((untouched as unknown as { _conflicts?: string[] })._conflicts).toHaveLength(1)
    } finally {
      watch.cancel()
    }
  })

  it('reports a failure of the feed itself', async () => {
    // PouchDB ends a live feed by emitting `error` on it. Unreported, the device simply stops
    // resolving conflicts and looks exactly like one that has none — the same silence this
    // whole milestone is about, one level up.
    const failures: unknown[] = []
    let feed: { emit(event: string, payload: unknown): void } | undefined
    const database = watching(three.deviceA, {
      onChanges: (opened) => {
        feed = opened
      },
    })

    const watch = on(database, '2026-08-20T11:00:00.000Z').watchConflicts((error) => {
      failures.push(error)
    })

    try {
      feed?.emit('error', new Error('the feed died'))
      expect(failures).toEqual([new Error('the feed died')])
    } finally {
      watch.cancel()
    }
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
