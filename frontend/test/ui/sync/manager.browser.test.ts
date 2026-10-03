import PouchDB from 'pouchdb-browser'
import { afterEach, describe, expect, it } from 'vitest'
import { type SyncManager, syncManager } from '../../../src/ui/sync/manager.js'

let counter = 0
const opened: PouchDB.Database[] = []
const managers: SyncManager[] = []

/** A fresh database, destroyed after the test. */
function database(): PouchDB.Database {
  counter += 1
  const db = new PouchDB(`manager-test-${counter}`)
  opened.push(db)
  return db
}

/** Waits for a condition, or gives up. */
async function until(condition: () => boolean | Promise<boolean>, what: string): Promise<void> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    if (await condition()) return
    await new Promise((resolve) => setTimeout(resolve, 25))
  }
  throw new Error(`timed out waiting for ${what}`)
}

/** A manager over real databases, one pair per `dbName`, stopped after the test. */
function realManager(unreachable = false) {
  const locals = new Map<string, PouchDB.Database>()
  const remotes = new Map<string, PouchDB.Database>()
  const pick = (map: Map<string, PouchDB.Database>, dbName: string) => {
    if (!map.has(dbName)) map.set(dbName, database())
    return map.get(dbName) as PouchDB.Database
  }
  const manager = syncManager({
    local: (dbName) => pick(locals, dbName) as never,
    remote: (dbName) =>
      unreachable
        ? (new PouchDB('http://127.0.0.1:1/nowhere', { skip_setup: true }) as never)
        : (pick(remotes, dbName) as never),
  })
  managers.push(manager)
  return { manager, local: (n: string) => pick(locals, n), remote: (n: string) => pick(remotes, n) }
}

const device = (id: string) => ({ _id: id, type: 'device', name: id })
const ONE = { projectId: 'p1', dbName: 'project_p1' }
const TWO = { projectId: 'p2', dbName: 'project_p2' }

afterEach(async () => {
  for (const manager of managers.splice(0)) manager.stopAll()
  for (const db of opened.splice(0)) await db.destroy().catch(() => undefined)
})

describe('pushing one project now', () => {
  it('resolves after the documents have landed', async () => {
    const { manager, local, remote } = realManager()
    await local('project_p1').put(device('device:one'))
    manager.set([ONE])

    await manager.pushNow('p1')

    expect((await remote('project_p1').get('device:one'))._id).toBe('device:one')
  })

  it('rejects against an unreachable server', async () => {
    const { manager, local } = realManager(true)
    await local('project_p1').put(device('device:one'))
    manager.set([ONE])

    await expect(manager.pushNow('p1')).rejects.toThrow()
  })

  it('rejects for a project it was never given', async () => {
    const { manager } = realManager()

    await expect(manager.pushNow('nope')).rejects.toThrow(/not being synchronized/)
  })

  it('still works after that project’s live sync was stopped', async () => {
    // Removing the local copy stops the sync first and then needs the final push.
    const { manager, local, remote } = realManager()
    manager.set([ONE])
    manager.stop('p1')
    await local('project_p1').put(device('device:late'))

    await manager.pushNow('p1')

    expect((await remote('project_p1').get('device:late'))._id).toBe('device:late')
  })
})

describe('stopping one project', () => {
  it('cancels that project and leaves the others replicating', async () => {
    const { manager, local, remote } = realManager()
    manager.set([ONE, TWO])
    manager.stop('p1')

    expect(manager.running()).toEqual(['p2'])
    expect(manager.stateOf('p1')).toBeUndefined()

    await local('project_p1').put(device('device:ignored'))
    await local('project_p2').put(device('device:followed'))
    await until(
      () =>
        remote('project_p2')
          .get('device:followed')
          .then(() => true)
          .catch(() => false),
      'the running project to replicate',
    )

    await expect(remote('project_p1').get('device:ignored')).rejects.toThrow()
  })

  it('is harmless for a project that is not running', () => {
    const { manager } = realManager()

    expect(() => manager.stop('nope')).not.toThrow()
  })
})
