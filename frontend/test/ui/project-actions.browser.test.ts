import PouchDB from 'pouchdb-browser'
import { afterEach, describe, expect, it } from 'vitest'
import { type LocalCache, type LocalProjectEntry, localCache } from '../../src/data/index.js'
import { PROJECT_DOCUMENT_ID } from '../../src/domain/documents/project.js'
import { PROJECT_DATABASE_NAME } from '../../src/ui/db/project-database.js'
import {
  createLocalProject,
  indexServerProject,
  type LocalProjectDependencies,
} from '../../src/ui/local-projects.js'
import {
  type ProjectActionDependencies,
  ProjectActionError,
  projectActions,
} from '../../src/ui/project-actions.js'
import {
  type NewProject,
  type Project,
  ProjectCreationError,
  type ProjectPatch,
} from '../../src/ui/projects.js'
import { type ProjectsModel, projectsModel, type Row } from '../../src/ui/projects-model.js'
import type { SyncableProject } from '../../src/ui/sync/manager.js'

/**
 * Promoting, downloading and removing projects, on real PouchDB databases.
 *
 * The databases and the local index are real, because every claim here is about data: that it
 * moved, that it survived a refusal, that it is gone. The server and replication are fakes that
 * record what they were asked, and can be told to fail once at a chosen step, so that "a retry
 * finishes the job without creating a second project" is tested at every point it can break.
 */

let counter = 0
/** Every database a test touched, destroyed afterwards by name (a destroyed handle is dead). */
const touched = new Set<string>()

afterEach(async () => {
  for (const name of touched) await new PouchDB(name).destroy().catch(() => undefined)
  touched.clear()
})

/** Where a fault is injected, once. */
type FaultAt = 'replicate' | 'push' | 'index' | 'destroy'

/** A device document, as the repositories would write it. */
const device = (id: string) => ({ _id: id, type: 'device', name: id })

/**
 * Counts documents in a database the test expects gone, through a handle of its own, so no
 * memoised one can answer. Only for those: PouchDB shares one IndexedDB connection per name, so
 * closing this handle would close a live one under the code being tested.
 */
async function documentCount(name: string): Promise<number> {
  const database = new PouchDB(name)
  try {
    return (await database.info()).doc_count
  } finally {
    await database.close()
  }
}

/** A world of one device: its index, its databases, a fake server and a fake replication. */
function world(options: { fault?: FaultAt } = {}) {
  counter += 1
  const run = `${counter}-${crypto.randomUUID().slice(0, 8)}`
  let fault = options.fault
  /** Takes the fault if it is armed for `at`, so it fires exactly once. */
  const fails = (at: FaultAt): boolean => {
    if (fault !== at) return false
    fault = undefined
    return true
  }

  const log: string[] = []
  const handles = new Map<string, PouchDB.Database>()
  const database = (dbName: string): PouchDB.Database => {
    touched.add(dbName)
    if (!dbName.startsWith('project_local') && fails('replicate')) {
      throw new Error('the new database could not be opened')
    }
    let handle = handles.get(dbName)
    if (handle === undefined) {
      handle = new PouchDB(dbName)
      const destroy = handle.destroy.bind(handle)
      handle.destroy = (async () => {
        log.push(`destroy ${dbName}`)
        if (fails('destroy')) throw new Error('the database would not go')
        return destroy()
      }) as never
      handles.set(dbName, handle)
    }
    return handle
  }

  const cacheName = `actions-cache-${run}`
  touched.add(cacheName)
  const realCache = localCache(new PouchDB(cacheName))
  const cache: LocalCache = {
    ...realCache,
    addLocalProject: async (entry: LocalProjectEntry) => {
      if (entry.projectId !== undefined && fails('index')) throw new Error('the index refused')
      return realCache.addLocalProject(entry)
    },
  }

  const local: LocalProjectDependencies = {
    cache: () => cache,
    database,
    forget: (dbName) => handles.delete(dbName),
    uuid: () => `${run}-${crypto.randomUUID().slice(0, 8)}`,
    now: () => '2026-10-03T09:00:00.000Z',
  }

  const server: Project[] = []
  const created: NewProject[] = []
  const updated: [string, ProjectPatch][] = []
  const sets: (readonly SyncableProject[])[] = []
  const pushes: string[] = []
  const switched: { dbName: string; id: string; editable: boolean }[] = []
  const state = {
    online: true,
    current: PROJECT_DATABASE_NAME,
    createFails: undefined as ConstructorParameters<typeof ProjectCreationError>[0] | undefined,
    pushFails: false,
    /**
     * Runs while a push is in flight, before it settles: a write made by another tab or a
     * background writer, which the push started too early to see.
     */
    duringPush: undefined as ((attempt: number) => Promise<void>) | undefined,
    refreshed: 0,
  }

  const deps: ProjectActionDependencies = {
    api: {
      list: async () => server,
      create: async (request) => {
        created.push(request)
        if (state.createFails !== undefined) throw new ProjectCreationError(state.createFails)
        const projectId = `p${run}-${created.length}`
        const project: Project = {
          projectId,
          dbName: `project_${projectId}`,
          name: request.name,
          ...(request.client === undefined ? {} : { client: request.client }),
          role: 'owner',
          owner: { ownerType: 'user', ownerId: 'me' },
          archived: false,
        }
        server.push(project)
        return project
      },
      update: async (projectId, patch) => {
        updated.push([projectId, patch])
        const index = server.findIndex((project) => project.projectId === projectId)
        const changed = { ...(server[index] as Project), ...(patch as Partial<Project>) }
        server[index] = changed
        return changed
      },
    },
    online: () => state.online,
    sync: {
      set: (projects) => {
        log.push('set')
        sets.push(projects)
      },
      pushNow: async (projectId) => {
        log.push(`push ${projectId}`)
        pushes.push(projectId)
        await state.duringPush?.(pushes.length)
        if (state.pushFails || fails('push')) throw new Error('a document was refused')
      },
      suspend: (projectId) => log.push(`suspend ${projectId}`),
      resume: (projectId) => log.push(`resume ${projectId}`),
    },
    local,
    currentDatabase: () => state.current,
    switchTo: (target) => {
      log.push(`switch ${target.dbName}`)
      switched.push(target)
      state.current = target.dbName
    },
    refresh: async () => {
      state.refreshed += 1
    },
  }

  /** The model the page would show now, and the row for one database. */
  const view = async (dbName: string): Promise<{ model: ProjectsModel; row: Row }> => {
    const model = projectsModel({
      local: await cache.readLocalProjects(),
      server,
      plan: 'member',
      session: 'signed-in',
      online: state.online,
      syncStates: () => undefined,
    })
    const row = [...model.owned, ...model.shared].find((candidate) => candidate.dbName === dbName)
    if (row === undefined) throw new Error(`no row for ${dbName}`)
    return { model, row }
  }

  /** A local-only project with two devices in it. */
  const localProject = async (name = 'Alpha', client?: string) => {
    const entry = await createLocalProject(
      { name, ...(client === undefined ? {} : { client }) },
      local,
    )
    await database(entry.dbName).bulkDocs([device('device:one'), device('device:two')])
    return entry
  }

  /** A server project with a synchronized copy here. */
  const syncedProject = async (name = 'Bravo') => {
    const project = await deps.api.create({ name })
    created.length = 0
    await indexServerProject(project, local)
    await database(project.dbName).put(device('device:copy'))
    return project
  }

  return {
    /** Counts documents in a database through the handle the code under test shares. */
    count: async (dbName: string) => (await database(dbName).info()).doc_count,
    actions: projectActions(deps),
    deps,
    state,
    log,
    server,
    created,
    updated,
    sets,
    pushes,
    switched,
    cache,
    database,
    view,
    localProject,
    syncedProject,
  }
}

/** The reason a refusal carried, or a failure if it did not refuse with one. */
async function refusal(action: Promise<void>): Promise<string> {
  const error = await action.then(
    () => undefined,
    (thrown: unknown) => thrown,
  )
  if (error instanceof ProjectActionError || error instanceof ProjectCreationError) {
    return error.reason
  }
  throw new Error(`expected a refusal, got ${String(error)}`)
}

describe('promoting a local-only project', () => {
  it('puts it on the server, moves its data under the server name and drops the old copy', async () => {
    const w = world()
    const alpha = await w.localProject('Alpha', 'Acme')
    w.state.current = alpha.dbName
    const { model, row } = await w.view(alpha.dbName)

    await w.actions.promote(model, row)

    expect(w.created).toEqual([{ name: 'Alpha', client: 'Acme' }])
    const [project] = w.server as [Project]
    const copy = w.database(project.dbName)
    expect((await copy.allDocs()).rows.map((doc) => doc.id)).toEqual(['device:one', 'device:two'])
    // The service owns the server database's project document; the local one must not travel.
    await expect(copy.get(PROJECT_DOCUMENT_ID)).rejects.toMatchObject({ status: 404 })
    expect(w.pushes).toEqual([project.projectId])
    expect(await w.cache.readLocalProjects()).toEqual([
      expect.objectContaining({
        dbName: project.dbName,
        projectId: project.projectId,
        role: 'owner',
        name: 'Alpha',
        client: 'Acme',
      }),
    ])
    expect(await documentCount(alpha.dbName)).toBe(0)
    expect(w.switched).toEqual([{ dbName: project.dbName, id: project.projectId, editable: true }])
    expect(w.sets.at(-1)).toEqual([{ projectId: project.projectId, dbName: project.dbName }])
    expect(w.state.refreshed).toBe(1)
    // The views move to the survivor before anything is copied, so this tab's writes land in
    // it; the old database goes only after the push has proved the server has everything.
    expect(w.log).toEqual([
      'set',
      `switch ${project.dbName}`,
      `push ${project.projectId}`,
      `destroy ${alpha.dbName}`,
    ])
  })

  it('copies again what was written to the old database while it was being pushed', async () => {
    const w = world()
    const alpha = await w.localProject()
    w.state.duringPush = async (attempt) => {
      if (attempt === 1) await w.database(alpha.dbName).put(device('device:late'))
    }
    const { model, row } = await w.view(alpha.dbName)

    await w.actions.promote(model, row)

    const [project] = w.server as [Project]
    expect(w.pushes).toEqual([project.projectId, project.projectId])
    expect((await w.database(project.dbName).get('device:late'))._id).toBe('device:late')
    expect(await documentCount(alpha.dbName)).toBe(0)
  })

  it('refuses, keeping the old database, when it is still being written to', async () => {
    const w = world()
    const alpha = await w.localProject()
    w.state.current = alpha.dbName
    w.state.duringPush = async (attempt) => {
      await w.database(alpha.dbName).put(device(`device:busy-${attempt}`))
    }
    const { model, row } = await w.view(alpha.dbName)

    expect(await refusal(w.actions.promote(model, row))).toBe('unpushed')

    expect(await w.count(alpha.dbName)).toBe(5)
    expect(w.state.current).toBe(alpha.dbName)
    const recorded = await w.cache.readLocalProjects()
    expect(recorded).toEqual([expect.objectContaining({ dbName: alpha.dbName })])
    // Finishing it later still creates nothing new.
    w.state.duringPush = undefined
    const again = await w.view(alpha.dbName)
    await w.actions.promote(again.model, again.row)
    expect(w.created).toHaveLength(1)
    const [project] = w.server as [Project]
    expect((await w.database(project.dbName).allDocs()).rows).toHaveLength(4)
  })

  for (const fault of ['replicate', 'push', 'index', 'destroy'] as const) {
    it(`finishes on a retry after failing at "${fault}", without a second project`, async () => {
      const w = world({ fault })
      const alpha = await w.localProject()
      w.state.current = alpha.dbName
      const first = await w.view(alpha.dbName)

      await expect(w.actions.promote(first.model, first.row)).rejects.toThrow()

      // Nothing is lost while it is half done: the data is still where it was, and the id is
      // remembered so the retry does not mint another project.
      const [project] = w.server as [Project]
      if (fault !== 'destroy') expect(await w.count(alpha.dbName)).toBe(3)
      const recorded = (await w.cache.readLocalProjects()).find((e) => e.dbName === alpha.dbName)
      expect(recorded?.projectId).toBe(project.projectId)

      const again = await w.view(alpha.dbName)
      expect(again.row.actions.promote).toEqual({ allowed: true })
      await w.actions.promote(again.model, again.row)

      expect(w.created).toHaveLength(1)
      expect(w.server).toHaveLength(1)
      expect((await w.database(project.dbName).allDocs()).rows).toHaveLength(2)
      expect(await w.cache.readLocalProjects()).toEqual([
        expect.objectContaining({ dbName: project.dbName, projectId: project.projectId }),
      ])
      expect(await documentCount(alpha.dbName)).toBe(0)
      expect(w.state.current).toBe(project.dbName)
    })
  }

  it('says why the server refused, and leaves the project as it was', async () => {
    const w = world()
    const alpha = await w.localProject()
    w.state.createFails = 'plan-no-sync'
    const { model, row } = await w.view(alpha.dbName)

    expect(await refusal(w.actions.promote(model, row))).toBe('plan-no-sync')

    w.state.createFails = 'project-limit-reached'
    expect(await refusal(w.actions.promote(model, row))).toBe('project-limit-reached')
    expect(await w.cache.readLocalProjects()).toEqual([alpha])
    expect(await w.count(alpha.dbName)).toBe(3)
    expect(w.sets).toEqual([])
  })

  it('does not ask the server when the model already refuses', async () => {
    const w = world()
    const alpha = await w.localProject()
    const model = projectsModel({
      local: [alpha],
      server: [],
      plan: 'free',
      session: 'signed-in',
      online: true,
      syncStates: () => undefined,
    })

    expect(await refusal(w.actions.promote(model, model.owned[0] as Row))).toBe('plan')
    expect(w.created).toEqual([])
  })
})

describe('downloading a server project', () => {
  it('lists it here with its role and starts replicating it', async () => {
    const w = world()
    const shared: Project = {
      projectId: `shared-${counter}`,
      dbName: `project_shared-${counter}`,
      name: 'Charlie',
      role: 'write',
      owner: { ownerType: 'user', ownerId: 'them' },
      archived: false,
    }
    w.server.push(shared)
    w.database(shared.dbName)
    const { model, row } = await w.view(shared.dbName)

    await w.actions.download(model, row)

    expect(await w.cache.readLocalProjects()).toEqual([
      expect.objectContaining({
        dbName: shared.dbName,
        projectId: shared.projectId,
        role: 'write',
      }),
    ])
    expect(w.sets.at(-1)).toEqual([{ projectId: shared.projectId, dbName: shared.dbName }])
    expect(w.state.refreshed).toBe(1)
  })

  it('archives even when that last push fails, and the copy then warns before deletion', async () => {
    const w = world()
    const bravo = await w.syncedProject()
    w.state.pushFails = true
    const { model, row } = await w.view(bravo.dbName)

    await w.actions.removeFromServer(model, row)

    expect(w.updated).toEqual([[bravo.projectId, { archived: true }]])
    expect((await w.view(bravo.dbName)).row.actions.deleteLocal).toEqual({
      allowed: true,
      warn: 'unpushed-may-be-lost',
    })
  })
})

describe('removing the local copy of a synchronized project', () => {
  it('is refused offline, before anything is touched', async () => {
    const w = world()
    const bravo = await w.syncedProject()
    const { model, row } = await w.view(bravo.dbName)
    w.state.online = false

    expect(await refusal(w.actions.removeLocalCopy(model, row))).toBe('offline')
    expect(w.log).toEqual([])
    expect(await w.count(bravo.dbName)).toBe(1)
    expect(await w.cache.readLocalProjects()).toHaveLength(1)
  })

  it('is refused when the push does not get everything through, and syncing resumes', async () => {
    const w = world()
    const bravo = await w.syncedProject()
    w.state.current = bravo.dbName
    w.state.pushFails = true
    const { model, row } = await w.view(bravo.dbName)

    expect(await refusal(w.actions.removeLocalCopy(model, row))).toBe('unpushed')

    expect(w.log).toEqual([
      `suspend ${bravo.projectId}`,
      `switch ${PROJECT_DATABASE_NAME}`,
      `push ${bravo.projectId}`,
      `switch ${bravo.dbName}`,
      `resume ${bravo.projectId}`,
    ])
    expect(await w.count(bravo.dbName)).toBe(1)
    expect(await w.cache.readLocalProjects()).toHaveLength(1)
    expect(w.state.current).toBe(bravo.dbName)
  })

  it('pushes again what was written to the copy during its push, then removes it', async () => {
    const w = world()
    const bravo = await w.syncedProject()
    const seen: number[] = []
    w.state.duringPush = async (attempt) => {
      seen.push((await w.database(bravo.dbName).info()).doc_count)
      if (attempt === 1) await w.database(bravo.dbName).put(device('device:late'))
    }
    const { model, row } = await w.view(bravo.dbName)

    await w.actions.removeLocalCopy(model, row)

    // The second push started with the late write already there to send.
    expect(seen).toEqual([1, 2])
    expect(await documentCount(bravo.dbName)).toBe(0)
  })

  it('refuses, keeping the copy, while it is still being written to', async () => {
    const w = world()
    const bravo = await w.syncedProject()
    w.state.current = bravo.dbName
    w.state.duringPush = async (attempt) => {
      await w.database(bravo.dbName).put(device(`device:busy-${attempt}`))
    }
    const { model, row } = await w.view(bravo.dbName)

    expect(await refusal(w.actions.removeLocalCopy(model, row))).toBe('unpushed')

    expect(await w.count(bravo.dbName)).toBe(3)
    expect(await w.cache.readLocalProjects()).toHaveLength(1)
    expect(w.state.current).toBe(bravo.dbName)
    expect(w.log.at(-1)).toBe(`resume ${bravo.projectId}`)
    expect(w.log).not.toContain(`destroy ${bravo.dbName}`)
  })

  it('pushes, moves off it if it is open, destroys it and stops replicating it', async () => {
    const w = world()
    const alpha = await w.localProject('Alpha')
    const bravo = await w.syncedProject('Bravo')
    w.state.current = bravo.dbName
    const { model, row } = await w.view(bravo.dbName)

    await w.actions.removeLocalCopy(model, row)

    expect(w.log).toEqual([
      `suspend ${bravo.projectId}`,
      `switch ${alpha.dbName}`,
      `push ${bravo.projectId}`,
      `destroy ${bravo.dbName}`,
      'set',
      `resume ${bravo.projectId}`,
    ])
    expect(w.switched).toEqual([{ dbName: alpha.dbName, id: alpha.dbName, editable: true }])
    expect(w.sets.at(-1)).toEqual([])
    expect(await documentCount(bravo.dbName)).toBe(0)
    expect(await w.cache.readLocalProjects()).toEqual([alpha])
    expect(w.state.refreshed).toBe(1)
  })

  it('falls back to the local catalogue when no other project is here', async () => {
    const w = world()
    const bravo = await w.syncedProject()
    w.state.current = bravo.dbName
    const { model, row } = await w.view(bravo.dbName)

    await w.actions.removeLocalCopy(model, row)

    expect(w.switched).toEqual([
      { dbName: PROJECT_DATABASE_NAME, id: PROJECT_DATABASE_NAME, editable: true },
    ])
  })
})

describe('deleting a local-only project', () => {
  it('requires the exact name, and keeps everything when it is not given', async () => {
    const w = world()
    const alpha = await w.localProject('Alpha')
    const { model, row } = await w.view(alpha.dbName)

    expect(await refusal(w.actions.deleteLocalProject(model, row, 'alpha'))).toBe('name-mismatch')
    expect(await refusal(w.actions.deleteLocalProject(model, row, ''))).toBe('name-mismatch')
    expect(await w.count(alpha.dbName)).toBe(3)
    expect(await w.cache.readLocalProjects()).toEqual([alpha])

    await w.actions.deleteLocalProject(model, row, ' Alpha ')

    expect(await documentCount(alpha.dbName)).toBe(0)
    expect(await w.cache.readLocalProjects()).toEqual([])
    expect(w.state.refreshed).toBe(1)
  })

  it('moves off it first when it is the open project', async () => {
    const w = world()
    const alpha = await w.localProject('Alpha')
    const bravo = await w.localProject('Bravo')
    w.state.current = alpha.dbName
    const { model, row } = await w.view(alpha.dbName)

    await w.actions.deleteLocalProject(model, row, 'Alpha')

    expect(w.log).toEqual([`switch ${bravo.dbName}`, `destroy ${alpha.dbName}`])
  })

  it('leaves the replication of a half-done promotion’s new copy alone', async () => {
    const w = world({ fault: 'push' })
    const alpha = await w.localProject('Alpha')
    const first = await w.view(alpha.dbName)
    await expect(w.actions.promote(first.model, first.row)).rejects.toThrow()
    const { model, row } = await w.view(alpha.dbName)
    w.log.length = 0

    await w.actions.deleteLocalProject(model, row, 'Alpha')

    expect(w.log).toEqual([`destroy ${alpha.dbName}`])
    expect(await documentCount(alpha.dbName)).toBe(0)
  })
})

describe('removing a project from the server', () => {
  it('archives it, stops replicating it and keeps the local copy', async () => {
    const w = world()
    const bravo = await w.syncedProject()
    const { model, row } = await w.view(bravo.dbName)

    await w.actions.removeFromServer(model, row)

    // Pushed first: once archived, the server takes nothing more.
    expect(w.log.slice(0, 1)).toEqual([`push ${bravo.projectId}`])
    expect(w.updated).toEqual([[bravo.projectId, { archived: true }]])
    expect(w.sets.at(-1)).toEqual([])
    expect(await w.count(bravo.dbName)).toBe(1)
    expect(await w.cache.readLocalProjects()).toHaveLength(1)
    expect((await w.view(bravo.dbName)).row).toMatchObject({ location: 'local', editable: false })
    expect(w.state.refreshed).toBe(1)
  })
})
