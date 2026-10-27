import PouchDB from 'pouchdb-browser'
import { afterEach, describe, expect, it } from 'vitest'
import {
  coordinateWrites,
  databaseLockName,
  withDestroyLock,
  withWriteLock,
} from '../../../src/ui/db/db-lock.js'
import { forgetProject, openProject } from '../../../src/ui/db/project-database.js'

/**
 * The per-database Web Lock protocol of #220, on the real lock manager: these tests run in a
 * browser, so "two tabs" is two holders of the same origin-wide lock, which is exactly what two
 * tabs are to it.
 */

/** A deferred, so a test can hold a lock open and decide when the holder lets go. */
function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void
  const promise = new Promise<void>((r) => {
    resolve = r
  })
  return { promise, resolve }
}

/** Holds `mode` on the database's lock until released, reporting when it is actually held. */
function hold(dbName: string, mode: LockMode) {
  const acquired = deferred()
  const release = deferred()
  const work = async (): Promise<void> => {
    acquired.resolve()
    await release.promise
  }
  const done = mode === 'exclusive' ? withDestroyLock(dbName, work) : withWriteLock(dbName, work)
  return { acquired: acquired.promise, release: release.resolve, done }
}

/** A few macrotasks: long enough for an unblocked write to land, no part of any lock. */
const settleTime = () => new Promise((resolve) => setTimeout(resolve, 50))

/** A device the repositories accept, with nothing these tests care about. */
const device = (id: string) => ({
  _id: id,
  type: 'device' as const,
  name: id,
  room: 'Kitchen',
  manualCode: '34970112332',
  installedAt: '2026-08-26',
  addedAt: '2026-08-26T09:00:00.000Z',
  disabled: false,
  remarks: [],
})

let counter = 0
const touched = new Set<string>()
const dbName = (): string => {
  counter += 1
  const name = `lock-${counter}-${crypto.randomUUID().slice(0, 8)}`
  touched.add(name)
  return name
}

afterEach(async () => {
  for (const name of touched) {
    forgetProject(name)
    await new PouchDB(name).destroy().catch(() => undefined)
  }
  touched.clear()
})

describe('the per-database lock', () => {
  it('makes a destroy wait for a write in flight, and later writes wait for the destroy', async () => {
    const name = dbName()
    const order: string[] = []

    const writer = hold(name, 'shared')
    await writer.acquired
    const destroyer = withDestroyLock(name, async () => {
      order.push('destroy')
    })
    await settleTime()
    expect(order).toEqual([]) // the destroy waits for the writer

    const late = withWriteLock(name, async () => {
      order.push('late write')
    })
    writer.release()
    await Promise.all([destroyer, late])
    expect(order).toEqual(['destroy', 'late write']) // the destroy went first, then the write
  })

  it('lets writers run together, and scopes the lock to one database', async () => {
    const name = dbName()
    const other = dbName()
    const first = hold(name, 'shared')
    await first.acquired

    // A second shared holder is not delayed by the first…
    let secondRan = false
    await withWriteLock(name, async () => {
      secondRan = true
    })
    expect(secondRan).toBe(true)

    // …and another database's destroy is not delayed by this one's writer.
    let otherDestroyRan = false
    await withDestroyLock(other, async () => {
      otherDestroyRan = true
    })
    expect(otherDestroyRan).toBe(true)

    first.release()
    await first.done
  })

  it('returns the work’s result and releases the lock when the work throws', async () => {
    const name = dbName()
    expect(await withDestroyLock(name, async () => 'destroyed')).toBe('destroyed')

    await expect(
      withDestroyLock(name, async () => {
        throw new Error('the destroy failed')
      }),
    ).rejects.toThrow('the destroy failed')

    // The lock is free again: the next holder is granted at once.
    let ran = false
    await withWriteLock(name, async () => {
      ran = true
    })
    expect(ran).toBe(true)
  })

  it('degrades to today’s uncoordinated behaviour where there are no Web Locks', async () => {
    // Older browsers (Safari before 15.4) have no navigator.locks. Everything must still run —
    // bare, exactly as before #220 — rather than crash.
    const name = dbName()
    Object.defineProperty(navigator, 'locks', { value: undefined, configurable: true })
    try {
      const destroyer = hold(name, 'exclusive')
      await destroyer.acquired
      // With no locks, a write during a "held" destroy is not delayed: today's behaviour.
      let wrote = false
      await withWriteLock(name, async () => {
        wrote = true
      })
      expect(wrote).toBe(true)
      destroyer.release()
      await destroyer.done

      expect(await withDestroyLock(name, async () => 'ran')).toBe('ran')
      await expect(
        withWriteLock(name, async () => {
          throw new Error('still visible')
        }),
      ).rejects.toThrow('still visible')
    } finally {
      Reflect.deleteProperty(navigator, 'locks')
    }
    expect(navigator.locks).toBeDefined() // the prototype's lock manager is back
  })
})

describe('writes through a project handle', () => {
  it('delays a write while the destroy lock is held — `put` included, through `bulkDocs`', async () => {
    const name = dbName()
    const database = coordinateWrites(name, new PouchDB(name))
    const destroyer = hold(name, 'exclusive')
    await destroyer.acquired

    let landed = false
    const write = database.put(device('device:waiting')).then(() => {
      landed = true
    })
    await settleTime()
    expect(landed).toBe(false) // held off while the destroy lock is held

    destroyer.release()
    await Promise.all([write, destroyer.done])
    expect((await database.get('device:waiting'))._id).toBe('device:waiting')
    await database.close()
  })

  it('opens a project into the same coordination, so a destroy cannot race a fresh open', async () => {
    // #220's second promise: a database freshly opened for writing participates. The lock is
    // held as a destroy holds it; a write through a handle opened *while it is held* must wait.
    const name = dbName()
    const destroyer = hold(name, 'exclusive')
    await destroyer.acquired

    const repositories = openProject(name)
    let landed = false
    const write = repositories.devices.save(device('device:fresh')).then(() => {
      landed = true
    })
    await settleTime()
    expect(landed).toBe(false)

    destroyer.release()
    await Promise.all([write, destroyer.done])
    expect(landed).toBe(true) // the write was delayed, not refused: nothing was destroyed
  })

  it('names the lock after the database, so tooling can see who holds what', async () => {
    expect(databaseLockName('project_p1')).toBe('mm-db:project_p1')
  })
})
