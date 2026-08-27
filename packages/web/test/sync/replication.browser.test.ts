import PouchDB from 'pouchdb-browser'
import { afterEach, describe, expect, it } from 'vitest'
import { replicateProject, type SyncHandle, type SyncState } from '../../src/sync/replication.js'

let counter = 0
const opened: PouchDB.Database[] = []
const running: SyncHandle[] = []

/** A fresh database, destroyed after the test. */
function database(): PouchDB.Database {
  counter += 1
  const db = new PouchDB(`sync-test-${counter}`)
  opened.push(db)
  return db
}

/** Starts a replication that is stopped after the test whatever the test does. */
function start(...args: Parameters<typeof replicateProject>): SyncHandle {
  const handle = replicateProject(...args)
  running.push(handle)
  return handle
}

/** Waits for a condition, or gives up. Replication is asynchronous in a way no promise exposes. */
async function until(condition: () => boolean | Promise<boolean>, what: string): Promise<void> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    if (await condition()) return
    await new Promise((resolve) => setTimeout(resolve, 25))
  }
  throw new Error(`timed out waiting for ${what}`)
}

/** Whether a document is present. */
const has = (db: PouchDB.Database, id: string) => async () =>
  await db
    .get(id)
    .then(() => true)
    .catch(() => false)

const device = (id: string) => ({ _id: id, type: 'device', name: id })

afterEach(async () => {
  for (const handle of running.splice(0)) handle.cancel()
  for (const db of opened.splice(0)) await db.destroy().catch(() => undefined)
})

describe('projects sync automatically', () => {
  it('sends what this browser has to the server', async () => {
    const local = database()
    const remote = database()
    await local.put(device('device:lamp'))

    start(local as never, remote)

    await until(has(remote, 'device:lamp'), 'the device to reach the server')
  })

  it('brings down what the server has', async () => {
    // The first scenario: signing in on a second device and finding the devices there.
    const local = database()
    const remote = database()
    await remote.put(device('device:sensor'))

    start(local as never, remote)

    await until(has(local, 'device:sensor'), 'the device to arrive from the server')
  })

  it('keeps going without being asked again', async () => {
    // `live`. "Without any action from me" is the acceptance criterion, and a sync that had to
    // be triggered would put the action back.
    //
    // The wait for `idle` is what makes this a test of liveness rather than of timing: without
    // it the document is written while the first pass may still be running, so a one-shot sync
    // would carry it too and the test would pass against a replication that stops.
    const local = database()
    const remote = database()
    const states: SyncState[] = []
    start(local as never, remote, { onState: (state) => states.push(state) })
    await until(() => states.includes('idle'), 'the first pass to finish')

    await local.put(device('device:added-later'))

    await until(has(remote, 'device:added-later'), 'a later change to propagate')
  })

  it('tells the caller when documents arrive, so a view can re-read', async () => {
    let incoming = 0
    const local = database()
    const remote = database()
    start(local as never, remote, { onIncoming: () => (incoming += 1) })

    await remote.put(device('device:from-elsewhere'))

    await until(() => incoming > 0, 'an incoming change to be reported')
  })

  it('does not report this browser’s own writes as incoming', async () => {
    // A view re-reading because it wrote something would be reacting to news it already had.
    let incoming = 0
    const local = database()
    const remote = database()
    start(local as never, remote, { onIncoming: () => (incoming += 1) })

    await local.put(device('device:mine'))
    await until(has(remote, 'device:mine'), 'the write to propagate')

    expect(incoming).toBe(0)
  })
})

describe('replication survives interruption', () => {
  it('resumes from where it stopped rather than restarting', async () => {
    // **The third scenario, tested for real.** PouchDB writes a checkpoint at both ends after
    // each batch; a second sync reads it and starts from there. What that means observably is
    // that the second sync transfers only what is new — so this counts the documents that move.
    const local = database()
    const remote = database()
    for (const id of ['device:one', 'device:two', 'device:three']) await local.put(device(id))

    const first = start(local as never, remote)
    await until(has(remote, 'device:three'), 'the first batch to arrive')
    first.cancel()

    await local.put(device('device:four'))

    let moved = 0
    start(local as never, remote, { onIncoming: () => undefined })
    // Counting through the remote's own change feed rather than the sync's events: what is
    // being asserted is what crossed, and the remote is where it lands.
    const since = (await remote.info()).update_seq
    await until(has(remote, 'device:four'), 'the fourth device to arrive')
    const changes = await remote.changes({ since })
    moved = changes.results.length

    // One document, not four. A sync that restarted would move all four again.
    expect(moved).toBe(1)
  })

  it('moves everything the first time, so the test above is measuring something', async () => {
    // The control for the resume test. Without it, "only one document moved" would pass just as
    // happily against a replication that moved nothing at all.
    const local = database()
    const remote = database()
    for (const id of ['device:one', 'device:two', 'device:three']) await local.put(device(id))

    const since = (await remote.info()).update_seq
    start(local as never, remote)
    await until(has(remote, 'device:three'), 'the batch to arrive')

    expect((await remote.changes({ since })).results.length).toBe(3)
  })
})

describe('what the interface is told', () => {
  it('reports its state from the start', async () => {
    const states: SyncState[] = []
    start(database() as never, database(), { onState: (state) => states.push(state) })

    expect(states[0]).toBeDefined()
  })

  it('settles on idle once there is nothing left to send', async () => {
    // The steady state. An interface that showed "syncing" forever would be describing the
    // feature rather than the situation.
    const states: SyncState[] = []
    start(database() as never, database(), { onState: (state) => states.push(state) })

    await until(() => states.includes('idle'), 'the sync to settle')
  })

  it('says stopped after it is cancelled', async () => {
    const handle = start(database() as never, database())
    handle.cancel()

    expect(handle.state()).toBe('stopped')
  })

  it('stays stopped even though PouchDB pauses afterwards', async () => {
    // Cancelling emits a `paused`, and letting it through would leave the interface saying
    // "waiting for a connection" about a replication nobody is running.
    const states: SyncState[] = []
    const handle = start(database() as never, database(), { onState: (s) => states.push(s) })
    handle.cancel()

    await new Promise((resolve) => setTimeout(resolve, 100))

    expect(states.at(-1)).toBe('stopped')
    expect(handle.state()).toBe('stopped')
  })

  it('ignores an answer that arrives after it was cancelled', async () => {
    // The probe is a request in flight: it goes out while the sync is running and resolves
    // after it has stopped. Reporting that answer would move a stopped replication back to
    // `idle` — an interface saying "up to date" about something nobody is running.
    // A stub local, because the pause has to be fired at a chosen moment: with two real
    // databases the window between the probe going out and the cancel is not controllable.
    const states: SyncState[] = []
    const handlers = new Map<string, (arg?: unknown) => void>()
    const stub = {
      sync: () => ({
        on: (event: string, handler: (arg?: unknown) => void) => handlers.set(event, handler),
        cancel: () => undefined,
      }),
    }
    const slow = { info: () => new Promise((resolve) => setTimeout(() => resolve({}), 150)) }

    const handle = replicateProject(stub as never, slow as never, {
      onState: (state) => states.push(state),
    })

    handlers.get('paused')?.(undefined)
    // Cancel while the probe is still out: the request went while the sync was running.
    handle.cancel()
    await new Promise((resolve) => setTimeout(resolve, 300))

    expect(states.at(-1)).toBe('stopped')
    expect(handle.state()).toBe('stopped')
  })

  it('can be cancelled twice without complaint', async () => {
    // Called from a view's teardown, which can run more than once.
    const handle = start(database() as never, database())
    handle.cancel()

    expect(() => handle.cancel()).not.toThrow()
  })

  it('reports being cancelled exactly once', async () => {
    const states: SyncState[] = []
    const handle = start(database() as never, database(), { onState: (s) => states.push(s) })
    handle.cancel()
    handle.cancel()

    expect(states.filter((state) => state === 'stopped')).toHaveLength(1)
  })
})

describe('what it asks PouchDB for', () => {
  // Two options that cannot be observed from outside in this environment, and that decide two
  // of the three scenarios. `live` has a behavioural test above; `retry` does not, because
  // proving it needs a server that fails and then works, which a browser test has no way to
  // arrange. Asserting the request is worth more than leaving the requirement unstated — and
  // this is the only place in these tests that looks at a call rather than at an outcome.
  it('asks for a live, retrying sync', () => {
    let asked: { live: boolean; retry: boolean } | undefined
    const stub = {
      sync: (_remote: unknown, options: { live: boolean; retry: boolean }) => {
        asked = options
        return { on: () => undefined, cancel: () => undefined }
      },
    }

    replicateProject(stub as never, { info: async () => ({}) })

    expect(asked).toEqual({ live: true, retry: true })
  })
})

describe('a server that cannot be reached', () => {
  it('says so, rather than reporting that everything is caught up', async () => {
    // **The one that would have shipped wrong.** PouchDB emits `paused` with no argument both
    // when the replication has caught up and when it has never once reached the server —
    // verified in this browser: against 127.0.0.1:1 the events are `paused(undefined)` twice
    // and nothing else. Reading that as "idle" would show a user a synced project that has
    // never synchronised, which is the one failure they cannot detect for themselves.
    const local = database()
    const unreachable = new PouchDB('http://127.0.0.1:1/nowhere', { skip_setup: true })

    const handle = start(local as never, unreachable)

    await until(() => handle.state() === 'offline', 'the sync to report being offline')
  })

  it('does not stop replicating', async () => {
    // Being offline is ordinary here and the local database is complete and usable, so a sync
    // that gave up would be silently not syncing.
    const local = database()
    const unreachable = new PouchDB('http://127.0.0.1:1/nowhere', { skip_setup: true })

    const handle = start(local as never, unreachable)
    await until(() => handle.state() === 'offline', 'the sync to report being offline')

    expect(handle.state()).not.toBe('stopped')
  })

  it('keeps the local database working while it cannot reach anything', async () => {
    // The whole premise of the application. Nothing about a failed sync may block a write.
    const local = database()
    const unreachable = new PouchDB('http://127.0.0.1:1/nowhere', { skip_setup: true })
    start(local as never, unreachable)

    await local.put(device('device:written-offline'))

    expect(await has(local, 'device:written-offline')()).toBe(true)
  })
})
