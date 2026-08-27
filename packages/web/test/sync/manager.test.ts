import { describe, expect, it } from 'vitest'
import {
  type ManagerDependencies,
  type SyncableProject,
  syncManager,
} from '../../src/sync/manager.js'

const KITCHEN: SyncableProject = { projectId: 'p1', dbName: 'project_p1' }
const GARAGE: SyncableProject = { projectId: 'p2', dbName: 'project_p2' }

/**
 * A manager over stub databases, recording every sync that was started and cancelled.
 *
 * The stubs are deliberately inert: what this file tests is *which* replications exist and
 * when, which is the manager's whole job. That replication itself works is
 * `replication.browser.test.ts`, against two real databases in a real browser.
 */
function manager() {
  const started: string[] = []
  const cancelled: string[] = []
  const pause = new Map<string, (error?: unknown) => void>()
  const change = new Map<string, (info: { direction: string }) => void>()

  const deps: ManagerDependencies = {
    local: (dbName) =>
      ({
        sync: () => ({
          on: (event: string, handler: never) => {
            if (event === 'paused') pause.set(dbName, handler)
            if (event === 'change') change.set(dbName, handler)
          },
          cancel: () => cancelled.push(dbName),
        }),
      }) as never,
    remote: (dbName) => {
      started.push(dbName)
      return { info: async () => ({}) } as never
    },
  }

  return { started, cancelled, pause, change, deps }
}

describe('keeping the replications matched to the projects', () => {
  it('starts one per project', () => {
    const { started, deps } = manager()
    syncManager(deps).set([KITCHEN, GARAGE])

    expect(started).toEqual(['project_p1', 'project_p2'])
  })

  it('starts nothing until it is told what to sync', () => {
    const { started, deps } = manager()
    syncManager(deps)

    expect(started).toEqual([])
  })

  it('reports what is running', () => {
    const { deps } = manager()
    const running = syncManager(deps)
    running.set([KITCHEN, GARAGE])

    expect(running.running()).toEqual(['p1', 'p2'])
  })

  it('starts a project that appears later', () => {
    // Somebody shared one. The first scenario is "sign in on a second device and both
    // replicate"; this is the same thing arriving while the tab is open.
    const { started, deps } = manager()
    const running = syncManager(deps)
    running.set([KITCHEN])
    running.set([KITCHEN, GARAGE])

    expect(started).toEqual(['project_p1', 'project_p2'])
  })

  it('stops a project that goes away', () => {
    // **Access removed.** A replication left running is a live connection to a database this
    // browser may no longer read — CouchDB refuses it, and the interface then shows a project
    // that is permanently "offline" rather than one that is gone.
    const { cancelled, deps } = manager()
    const running = syncManager(deps)
    running.set([KITCHEN, GARAGE])
    running.set([KITCHEN])

    expect(cancelled).toEqual(['project_p2'])
    expect(running.running()).toEqual(['p1'])
  })

  it('stops the departed before starting the arrived', () => {
    // Not tidiness: for the moment both lists are being reconciled, a project somebody has just
    // been removed from must not still be replicating.
    const order: string[] = []
    const { deps } = manager()
    const running = syncManager({
      ...deps,
      local: (dbName) =>
        ({
          sync: () => ({
            on: () => undefined,
            cancel: () => order.push(`stop ${dbName}`),
          }),
        }) as never,
      remote: (dbName) => {
        order.push(`start ${dbName}`)
        return { info: async () => ({}) } as never
      },
    })

    running.set([KITCHEN])
    order.length = 0
    running.set([GARAGE])

    expect(order).toEqual(['stop project_p1', 'start project_p2'])
  })

  it('leaves a running project alone', () => {
    // **The one that matters for the third scenario.** The project list is re-fetched whenever
    // connectivity returns; restarting every replication each time would throw away the
    // checkpoint each one holds and re-scan the whole database — on exactly the connection
    // least able to afford it.
    const { started, cancelled, deps } = manager()
    const running = syncManager(deps)
    running.set([KITCHEN])
    running.set([KITCHEN])
    running.set([KITCHEN])

    expect(started).toEqual(['project_p1'])
    expect(cancelled).toEqual([])
  })

  it('stops everything when asked', () => {
    // Signing out, and a page being torn down.
    const { cancelled, deps } = manager()
    const running = syncManager(deps)
    running.set([KITCHEN, GARAGE])

    running.stopAll()

    expect(cancelled).toEqual(['project_p1', 'project_p2'])
    expect(running.running()).toEqual([])
  })

  it('stops everything when the list becomes empty', () => {
    // Which is what signing out looks like from the list's point of view, and what a user with
    // no projects looks like too.
    const { cancelled, deps } = manager()
    const running = syncManager(deps)
    running.set([KITCHEN, GARAGE])

    running.set([])

    expect(cancelled).toEqual(['project_p1', 'project_p2'])
  })

  it('can be started again after being stopped', () => {
    const { started, deps } = manager()
    const running = syncManager(deps)
    running.set([KITCHEN])
    running.stopAll()
    running.set([KITCHEN])

    expect(started).toEqual(['project_p1', 'project_p1'])
  })
})

describe('what the interface is told', () => {
  it('reports a project’s state with its id', () => {
    // An interface showing "2 of 3 projects available offline" needs to know which is which.
    const reported: Array<[string, string]> = []
    const { deps, pause } = manager()
    syncManager({ ...deps, onState: (id, state) => reported.push([id, state]) }).set([KITCHEN])

    pause.get('project_p1')?.(undefined)

    expect(reported[0]?.[0]).toBe('p1')
  })

  it('remembers the latest state per project', async () => {
    const { deps, pause } = manager()
    const running = syncManager(deps)
    running.set([KITCHEN])

    pause.get('project_p1')?.(undefined)
    await new Promise((resolve) => setTimeout(resolve, 10))

    expect(running.stateOf('p1')).toBe('idle')
  })

  it('says which project documents arrived for', () => {
    // A view showing one project re-reads when *that* project changes. Reporting every
    // project's changes under one id would make every open view re-read on every change
    // anywhere, which on a phone with several projects is a lot of work to display nothing new.
    const arrived: string[] = []
    const { deps, change } = manager()
    syncManager({ ...deps, onIncoming: (id) => arrived.push(id) }).set([KITCHEN, GARAGE])

    change.get('project_p2')?.({ direction: 'pull' })

    expect(arrived).toEqual(['p2'])
  })

  it('knows nothing about a project that is not running', () => {
    const { deps } = manager()

    expect(syncManager(deps).stateOf('p9')).toBeUndefined()
  })

  it('forgets a project’s state when it stops', () => {
    // A stale "idle" for a project the user no longer has would show it as synced and present.
    const { deps } = manager()
    const running = syncManager(deps)
    running.set([KITCHEN])
    running.set([])

    expect(running.stateOf('p1')).toBeUndefined()
  })
})
