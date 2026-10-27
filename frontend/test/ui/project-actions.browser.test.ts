import PouchDB from 'pouchdb-browser'
import { afterEach, beforeAll, describe, expect, it } from 'vitest'
import {
  type LocalCache,
  type LocalProjectEntry,
  localCache,
  projectRepositories,
} from '../../src/data/index.js'
import { encodeBase64 } from '../../src/domain/crypto/base64.js'
import {
  decryptField,
  deriveKid,
  encryptField,
  unwrapDek,
} from '../../src/domain/crypto/envelope.js'
import {
  ESCROW_KEY_DOCUMENT_ID,
  type ProjectKeyDocument,
  projectKeyDocumentId,
} from '../../src/domain/documents/keys.js'
import { PROJECT_DOCUMENT_ID } from '../../src/domain/documents/project.js'
import { type DeviceDocument, documentId, type Unsaved } from '../../src/domain/index.js'
import { coordinateWrites } from '../../src/ui/db/db-lock.js'
import { ensureDeviceKey } from '../../src/ui/db/device-key.js'
import {
  createProjectKeys,
  ensureEscrowWrap,
  resolveKeyState,
  unlockProject,
} from '../../src/ui/db/keyring.js'
import { PROJECT_DATABASE_NAME } from '../../src/ui/db/project-database.js'
import type { EscrowKeyInfo } from '../../src/ui/escrow-client.js'
import {
  createLocalProject,
  detachOrphanedProject,
  indexServerProject,
  type LocalProjectDependencies,
  renameLocalProject,
} from '../../src/ui/local-projects.js'
import {
  CreatedLocallyError,
  type ProjectActionDependencies,
  ProjectActionError,
  projectActions,
} from '../../src/ui/project-actions.js'
import { projectActionRunning } from '../../src/ui/project-busy.js'
import {
  type NewProject,
  type Project,
  ProjectCreationError,
  type ProjectPatch,
  ProjectUpdateError,
} from '../../src/ui/projects.js'
import {
  type ProjectsInput,
  type ProjectsModel,
  projectsModel,
  type Row,
} from '../../src/ui/projects-model.js'
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

/**
 * The escrow key pair the fake server holds (#305): a real RSA-OAEP pair, so a wrap sent at
 * provisioning can be opened here exactly as the server's test-unwrap would. 2048-bit, which
 * the envelope accepts, to keep the file quick; the key size is not what is under test.
 */
let escrowPair: { info: EscrowKeyInfo; privateKey: CryptoKey }

beforeAll(async () => {
  const pair = await crypto.subtle.generateKey(
    {
      name: 'RSA-OAEP',
      modulusLength: 2048,
      publicExponent: new Uint8Array([0x01, 0x00, 0x01]),
      hash: 'SHA-256',
    },
    false,
    ['wrapKey', 'unwrapKey'],
  )
  const publicKey = encodeBase64(
    new Uint8Array(await crypto.subtle.exportKey('spki', pair.publicKey)),
  )
  escrowPair = {
    info: { kid: await deriveKid(publicKey), alg: 'RSA-OAEP-256', publicKey },
    privateKey: pair.privateKey,
  }
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
function world(
  options: {
    fault?: FaultAt
    /** What `mm-local` has cached of the escrow key; the test key unless given. */
    cachedEscrow?: EscrowKeyInfo | null
    /** What `GET /escrowkey` answers; the test key unless given, `null` being a 404. */
    fetchedEscrow?: EscrowKeyInfo | null | Error
  } = {},
) {
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
        await state.beforeDestroy?.()
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
    account: async () => (await cache.readProfile().catch(() => undefined))?.sub,
    signedIn: async () => false,
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
    updateFails: undefined as ConstructorParameters<typeof ProjectUpdateError>[0] | undefined,
    pushFails: false,
    /**
     * Runs while a push is in flight, before it settles: a write made by another tab or a
     * background writer, which the push started too early to see.
     */
    duringPush: undefined as ((attempt: number) => Promise<void>) | undefined,
    /**
     * Runs after the action's final `update_seq` check, just before the destroy: the #220
     * window, in which another tab's write must not be able to land.
     */
    beforeDestroy: undefined as (() => Promise<void>) | undefined,
    refreshed: 0,
    onRefresh: undefined as (() => void) | undefined,
    /** Runs as `POST /projects` arrives, before it answers: the moment provisioning sees. */
    onCreate: undefined as (() => Promise<void>) | undefined,
    /** How often `GET /escrowkey` was asked. */
    escrowFetches: 0,
  }

  const deps: ProjectActionDependencies = {
    api: {
      list: async () => server,
      create: async (request) => {
        created.push(request)
        await state.onCreate?.()
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
        if (state.updateFails !== undefined) throw new ProjectUpdateError(state.updateFails)
        const index = server.findIndex((project) => project.projectId === projectId)
        const changed = { ...(server[index] as Project), ...(patch as Partial<Project>) }
        server[index] = changed
        return changed
      },
    },
    online: () => state.online,
    escrowKey: {
      cached: async () =>
        options.cachedEscrow === undefined ? escrowPair.info : options.cachedEscrow,
      fetch: async () => {
        state.escrowFetches += 1
        const answer = options.fetchedEscrow
        if (answer instanceof Error) throw answer
        return answer === undefined ? escrowPair.info : answer
      },
    },
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
      state.onRefresh?.()
      state.refreshed += 1
    },
  }

  /** What the page would compute its model from now: the index, the server, a member online. */
  const input = async (over: Partial<ProjectsInput> = {}): Promise<ProjectsInput> => ({
    local: await cache.readLocalProjects(),
    server: [...server],
    plan: 'member',
    session: 'signed-in',
    online: state.online,
    syncStates: () => undefined,
    ...over,
  })

  /** The model the page would show now, and the row for one database. */
  const view = async (dbName: string): Promise<{ model: ProjectsModel; row: Row }> => {
    const model = projectsModel(await input())
    const row = [...model.owned, ...model.shared].find((candidate) => candidate.dbName === dbName)
    if (row === undefined) throw new Error(`no row for ${dbName}`)
    return { model, row }
  }

  // Since #302 a local project is born with one `key:<own kid>` wrap document beside its
  // `project` document, so a freshly created project holds **four** documents (project, wrap,
  // two devices) — and the wrap replicates with the data on promote (spec decision 8).
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
    input,
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
  if (
    error instanceof ProjectActionError ||
    error instanceof ProjectCreationError ||
    error instanceof ProjectUpdateError
  ) {
    return error.reason
  }
  throw new Error(`expected a refusal, got ${String(error)}`)
}

describe('promoting a local-only project', () => {
  it('holds the tab busy while it works, and lets go before refreshing', async () => {
    // A shell refresh in the middle would reopen the source and drop the survivor from
    // replication (`project-busy.ts`); the action's own refresh must see it let go.
    const w = world()
    const alpha = await w.localProject()
    w.state.current = alpha.dbName
    const seen: boolean[] = []
    w.state.duringPush = async () => {
      seen.push(projectActionRunning())
    }
    w.state.onRefresh = () => seen.push(projectActionRunning())
    const { model, row } = await w.view(alpha.dbName)

    await w.actions.promote(model, row)

    expect(seen).toEqual([true, false])
    expect(projectActionRunning()).toBe(false)
  })

  it('lets go when it is refused', async () => {
    const w = world({ fault: 'push' })
    const alpha = await w.localProject()
    const { model, row } = await w.view(alpha.dbName)

    await expect(w.actions.promote(model, row)).rejects.toThrow()

    expect(projectActionRunning()).toBe(false)
  })

  it('puts it on the server, moves its data under the server name and drops the old copy', async () => {
    const w = world()
    const alpha = await w.localProject('Alpha', 'Acme')
    w.state.current = alpha.dbName
    const { model, row } = await w.view(alpha.dbName)

    await w.actions.promote(model, row)

    expect(w.created).toEqual([
      {
        name: 'Alpha',
        client: 'Acme',
        escrowWrap: { kid: escrowPair.info.kid, wrapped: expect.any(String) },
      },
    ])
    const [project] = w.server as [Project]
    const copy = w.database(project.dbName)
    // The devices travel, and so do both key wraps — the copy must stay decryptable (#302) and
    // recoverable (#305).
    expect((await copy.allDocs()).rows.map((doc) => doc.id).sort()).toEqual(
      [
        'device:one',
        'device:two',
        ESCROW_KEY_DOCUMENT_ID,
        projectKeyDocumentId((await ensureDeviceKey()).kid),
      ].sort(),
    )
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

    // Project, two wraps, two devices and the two busy writes.
    expect(await w.count(alpha.dbName)).toBe(7)
    expect(w.state.current).toBe(alpha.dbName)
    const recorded = await w.cache.readLocalProjects()
    expect(recorded).toEqual([expect.objectContaining({ dbName: alpha.dbName })])
    // Finishing it later still creates nothing new.
    w.state.duringPush = undefined
    const again = await w.view(alpha.dbName)
    await w.actions.promote(again.model, again.row)
    expect(w.created).toHaveLength(1)
    const [project] = w.server as [Project]
    expect((await w.database(project.dbName).allDocs()).rows).toHaveLength(6)
  })

  it('brings back what was written to the new copy when the push is refused', async () => {
    // Ruling C-R11. The views moved to the survivor before the copy, so this tab's writes during
    // the transfer land there. A refusal moves the views back to the source and leaves the
    // survivor unlisted: without copying back, those writes would be stranded where nothing
    // names them.
    const w = world({ fault: 'push' })
    const alpha = await w.localProject()
    w.state.current = alpha.dbName
    w.state.duringPush = async () => {
      const [project] = w.server as [Project]
      await w.database(project.dbName).put(device('device:during'))
    }
    const { model, row } = await w.view(alpha.dbName)

    expect(await refusal(w.actions.promote(model, row))).toBe('unpushed')

    expect(w.state.current).toBe(alpha.dbName)
    expect((await w.database(alpha.dbName).get('device:during'))._id).toBe('device:during')
    // The source keeps its own project document, never one from the survivor.
    expect(await w.database(alpha.dbName).get(PROJECT_DOCUMENT_ID)).toMatchObject({ name: 'Alpha' })
  })

  it('shows the project once when only the old database would not go', async () => {
    // Everything moved and the copy is listed; only the source's destroy failed. The model
    // shows the copy alone, so the project is neither listed nor counted twice.
    const w = world({ fault: 'destroy' })
    const alpha = await w.localProject()
    const first = await w.view(alpha.dbName)

    await expect(w.actions.promote(first.model, first.row)).rejects.toThrow()

    const [project] = w.server as [Project]
    expect((await w.cache.readLocalProjects()).map((e) => e.dbName).sort()).toEqual(
      [alpha.dbName, project.dbName].sort(),
    )
    const { model, row } = await w.view(project.dbName)
    expect([...model.owned, ...model.shared]).toEqual([row])
    expect(row).toMatchObject({ location: 'synced', projectId: project.projectId })
    expect(model.ownedCount).toBe(1)
  })

  for (const fault of ['replicate', 'push', 'index'] as const) {
    it(`finishes on a retry after failing at "${fault}", without a second project`, async () => {
      const w = world({ fault })
      const alpha = await w.localProject()
      w.state.current = alpha.dbName
      const first = await w.view(alpha.dbName)

      await expect(w.actions.promote(first.model, first.row)).rejects.toThrow()

      // Nothing is lost while it is half done: the data is still where it was, and the id is
      // remembered so the retry does not mint another project.
      // The escrow wrap was added before `POST /projects` (#305), so five documents, not four.
      const [project] = w.server as [Project]
      expect(await w.count(alpha.dbName)).toBe(5)
      const recorded = (await w.cache.readLocalProjects()).find((e) => e.dbName === alpha.dbName)
      expect(recorded?.projectId).toBe(project.projectId)

      const again = await w.view(alpha.dbName)
      expect(again.row.actions.promote).toEqual({ allowed: true })
      await w.actions.promote(again.model, again.row)

      expect(w.created).toHaveLength(1)
      expect(w.server).toHaveLength(1)
      expect((await w.database(project.dbName).allDocs()).rows).toHaveLength(4)
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
    // Only the escrow wrap was added, which provisioning needed first and the project keeps.
    expect(await w.count(alpha.dbName)).toBe(5)
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

describe('going to the server carries a validated escrow wrap (#305)', () => {
  /** The stored `key:escrow` document of a database, or `undefined` when it has none. */
  const escrowWrapOf = async (database: PouchDB.Database) =>
    (await database.get(ESCROW_KEY_DOCUMENT_ID).catch(() => undefined)) as unknown as
      | ProjectKeyDocument
      | undefined

  it('provisioningSendsEscrowWrap: the body carries the source database’s own key:escrow', async () => {
    const w = world()
    const alpha = await w.localProject('Alpha')
    // Born with the escrow key cached, so the wrap is already there.
    await ensureEscrowWrap(w.database(alpha.dbName), escrowPair.info)
    const stored = await escrowWrapOf(w.database(alpha.dbName))
    if (stored === undefined) throw new Error('no escrow wrap was written')
    const { model, row } = await w.view(alpha.dbName)

    await w.actions.promote(model, row)

    // Exactly the stored wrap, not a fresh one: RSA-OAEP is randomised, so a re-wrap would
    // differ, and the server must validate the wrap that will actually replicate.
    expect(w.created).toEqual([
      { name: 'Alpha', escrowWrap: { kid: stored.kid, wrapped: stored.wrapped } },
    ])
    // The cached key was enough: nothing was asked of `GET /escrowkey`.
    expect(w.state.escrowFetches).toBe(0)
  })

  it('offlineBornProjectGetsWrapAtPromote: a project without key:escrow gets one before POST /projects', async () => {
    // Born offline with no escrow key cached, and still none cached: provisioning asks the server.
    const w = world({ cachedEscrow: null })
    const alpha = await w.localProject('Alpha')
    expect(await escrowWrapOf(w.database(alpha.dbName))).toBeUndefined()
    let atCreate: ProjectKeyDocument | undefined
    w.state.onCreate = async () => {
      atCreate = await escrowWrapOf(w.database(alpha.dbName))
    }
    const { model, row } = await w.view(alpha.dbName)

    await w.actions.promote(model, row)

    expect(w.state.escrowFetches).toBe(1)
    // Stored in the source before the request went out, and sent as stored.
    if (atCreate === undefined) throw new Error('key:escrow did not exist when provisioning ran')
    expect(atCreate).toMatchObject({ kid: escrowPair.info.kid, alg: 'RSA-OAEP-256' })
    expect(w.created[0]?.escrowWrap).toEqual({ kid: atCreate.kid, wrapped: atCreate.wrapped })
    // It wraps the project's own DEK: what the device key seals, the escrow key opens.
    const [project] = w.server as [Project]
    const deviceDek = await unlockProject(w.database(project.dbName))
    if (deviceDek === null) throw new Error('the survivor is locked')
    const escrowDek = await unwrapDek(atCreate.wrapped, escrowPair.privateKey)
    const sealed = await encryptField(deviceDek, 'device:x', 'payload', 'MT:Y.K9042C00KA0648G00')
    expect(await decryptField(escrowDek, 'device:x', 'payload', sealed)).toBe(
      'MT:Y.K9042C00KA0648G00',
    )
  })

  it('promoteCarriesKeyDocs: the survivor holds key:escrow and key:<kid>, and still decrypts', async () => {
    const w = world()
    const alpha = await w.localProject('Alpha')
    const source = w.database(alpha.dbName)
    const dek = await unlockProject(source)
    if (dek === null) throw new Error('a freshly created project is locked')
    const code = 'MT:Y.K9042C00KA0648G00'
    const sealed = await encryptField(dek, 'device:secret', 'payload', code)
    await source.put({ _id: 'device:secret', type: 'device', name: 'secret', payload: sealed })
    const { model, row } = await w.view(alpha.dbName)

    await w.actions.promote(model, row)

    const [project] = w.server as [Project]
    const survivor = w.database(project.dbName)
    const ids = (await survivor.allDocs()).rows.map((doc) => doc.id)
    expect(ids).toContain(ESCROW_KEY_DOCUMENT_ID)
    expect(ids).toContain(projectKeyDocumentId((await ensureDeviceKey()).kid))
    // The DEK is reused (decision 8): the ciphertext arrived byte for byte, not re-encrypted.
    const stored = (await survivor.get('device:secret')) as unknown as { payload: string }
    expect(stored.payload).toBe(sealed)
    // This device still opens it, and so does escrow — the recovery route for every other one.
    const deviceDek = await unlockProject(survivor)
    if (deviceDek === null) throw new Error('the survivor is locked')
    expect(await decryptField(deviceDek, 'device:secret', 'payload', stored.payload)).toBe(code)
    const escrow = await escrowWrapOf(survivor)
    if (escrow === undefined) throw new Error('no escrow wrap on the survivor')
    const escrowDek = await unwrapDek(escrow.wrapped, escrowPair.privateKey)
    expect(await decryptField(escrowDek, 'device:secret', 'payload', stored.payload)).toBe(code)
  })

  it('escrowDisabledFailsProvisioning: no escrow key anywhere refuses before anything is sent', async () => {
    // `GET /escrowkey` 404s: the deployment has the feature off.
    const w = world({ cachedEscrow: null, fetchedEscrow: null })
    const alpha = await w.localProject('Alpha')
    w.state.current = alpha.dbName
    const { model, row } = await w.view(alpha.dbName)

    expect(await refusal(w.actions.promote(model, row))).toBe('escrow-unavailable')

    expect(w.state.escrowFetches).toBe(1)
    expect(w.created).toEqual([])
    expect(w.sets).toEqual([])
    expect(w.state.current).toBe(alpha.dbName)
    expect(await w.cache.readLocalProjects()).toEqual([alpha])
    expect(await escrowWrapOf(w.database(alpha.dbName))).toBeUndefined()
    expect(await w.count(alpha.dbName)).toBe(4)
  })

  it('refuses offline before asking for the escrow key', async () => {
    const w = world({ cachedEscrow: null })
    const alpha = await w.localProject('Alpha')
    const { model, row } = await w.view(alpha.dbName)
    // The page rendered online; the browser says otherwise by the time it is chosen.
    w.state.online = false

    expect(await refusal(w.actions.promote(model, row))).toBe('offline')
    expect(w.state.escrowFetches).toBe(0)
    expect(w.created).toEqual([])
  })

  it('reads a network failure fetching the escrow key as unreachable', async () => {
    const w = world({ cachedEscrow: null, fetchedEscrow: new TypeError('Failed to fetch') })
    const alpha = await w.localProject('Alpha')
    const { model, row } = await w.view(alpha.dbName)

    expect(await refusal(w.actions.promote(model, row))).toBe('unreachable')
    expect(w.created).toEqual([])
  })

  it('reads any other failure fetching the escrow key as failed', async () => {
    const w = world({ cachedEscrow: null, fetchedEscrow: new Error('500') })
    const alpha = await w.localProject('Alpha')
    const { model, row } = await w.view(alpha.dbName)

    expect(await refusal(w.actions.promote(model, row))).toBe('failed')
    expect(w.created).toEqual([])
  })
})

describe('creating a project as synchronized is born locally, then promoted (#326)', () => {
  /** A device as the devices view would save it: both secrets in plaintext. */
  const lamp = (): Unsaved<DeviceDocument> => ({
    _id: documentId('device', '6ba7b810-9dad-11d1-80b4-00c04fd430c8'),
    type: 'device',
    name: 'Kitchen ceiling light',
    room: 'Ground Floor/Kitchen',
    payload: 'MT:Y.K9042C00KA0648G00',
    manualCode: '34970112332',
    vendorId: 0xfff1,
    productId: 0x8000,
    discriminator: 3840,
    installedAt: '2026-10-03',
    addedAt: '2026-10-03T09:00:00.000Z',
    disabled: false,
    remarks: [],
  })

  /**
   * Stands in for the server's CouchDB: every push replicates the server-named copy into a
   * database of its own, so "the server holds it" is read from a database the code under test
   * never opened, not from the copy it wrote.
   */
  const withRemote = (w: ReturnType<typeof world>): PouchDB.Database => {
    const remoteName = `remote-${crypto.randomUUID().slice(0, 8)}`
    touched.add(remoteName)
    const remote = new PouchDB(remoteName)
    w.state.duringPush = async () => {
      const [project] = w.server as [Project]
      const copied = await w.database(project.dbName).replicate.to(remote)
      if (copied.doc_write_failures > 0) throw new Error('the remote refused a document')
    }
    return remote
  }

  it('escrow on: the server database holds key:<kid> and key:escrow, and a device added afterwards is stored enc:v1:', async () => {
    const w = world()
    const remote = withRemote(w)

    await w.actions.createSynced(await w.input(), { name: 'Neu', client: 'Acme' })

    // One provisioning request, carrying the escrow wrap the server validates (decision 10).
    expect(w.created).toEqual([
      {
        name: 'Neu',
        client: 'Acme',
        escrowWrap: { kid: escrowPair.info.kid, wrapped: expect.any(String) },
      },
    ])
    const [project] = w.server as [Project]
    const remoteIds = (await remote.allDocs()).rows.map((doc) => doc.id)
    expect(remoteIds).toContain(ESCROW_KEY_DOCUMENT_ID)
    expect(remoteIds).toContain(projectKeyDocumentId((await ensureDeviceKey()).kid))
    // Born locally (decision 9): the local database is gone, only the server-named copy listed.
    expect(await w.cache.readLocalProjects()).toEqual([
      expect.objectContaining({ dbName: project.dbName, projectId: project.projectId }),
    ])
    expect(w.log.filter((line) => line.startsWith('destroy project_local'))).toHaveLength(1)

    // A device added afterwards goes through the encryption seam with the project's own DEK.
    const survivor = w.database(project.dbName)
    const repositories = projectRepositories(survivor, undefined, await resolveKeyState(survivor))
    await repositories.devices.save(lamp())
    await w.deps.sync.pushNow(project.projectId)
    const stored = (await remote.get(lamp()._id)) as unknown as DeviceDocument
    expect(stored.payload).toMatch(/^enc:v1:/)
    expect(stored.manualCode).toMatch(/^enc:v1:/)
    // And escrow opens it: the recovery route every other device takes.
    const escrow = (await remote.get(ESCROW_KEY_DOCUMENT_ID)) as unknown as ProjectKeyDocument
    const escrowDek = await unwrapDek(escrow.wrapped, escrowPair.privateKey)
    expect(await decryptField(escrowDek, lamp()._id, 'payload', stored.payload ?? '')).toBe(
      'MT:Y.K9042C00KA0648G00',
    )
  })

  it('escrow off: refuses with escrow-unavailable and keeps the project, local-only', async () => {
    // `GET /escrowkey` 404s and nothing is cached: the deployment has the feature off.
    const w = world({ cachedEscrow: null, fetchedEscrow: null })

    const error = await w.actions.createSynced(await w.input(), { name: 'Neu' }).then(
      () => undefined,
      (thrown: unknown) => thrown,
    )

    expect(error).toBeInstanceOf(CreatedLocallyError)
    const cause = (error as CreatedLocallyError).cause
    expect(cause).toBeInstanceOf(ProjectCreationError)
    expect((cause as ProjectCreationError).reason).toBe('escrow-unavailable')
    // Nothing reached the server, nothing replicates — never a plaintext server project.
    expect(w.created).toEqual([])
    expect(w.sets).toEqual([])
    // The reader's project exists, here, and reads local-only: no id, so not half-synced.
    const [kept] = (await w.cache.readLocalProjects()) as [LocalProjectEntry]
    expect(kept).toMatchObject({ name: 'Neu' })
    expect(kept.projectId).toBeUndefined()
    expect((error as CreatedLocallyError).entry).toEqual(kept)
    const { row } = await w.view(kept.dbName)
    expect(row.location).toBe('local')
    // It is still offered to synchronize later, once the server can take it.
    expect(row.actions.promote.allowed).toBe(true)
    // The page was asked to read what is there now, so it lists the kept project.
    expect(w.state.refreshed).toBe(1)
  })

  it('offline: refuses before anything is created, as before', async () => {
    const w = world()
    const input = await w.input()
    // The page rendered online; the browser says otherwise by the time Create is pressed.
    w.state.online = false

    expect(await refusal(w.actions.createSynced(input, { name: 'Neu' }))).toBe('offline')

    expect(await w.cache.readLocalProjects()).toEqual([])
    expect(w.created).toEqual([])
    expect(w.state.escrowFetches).toBe(0)
  })

  it('counts against the limit once: the last free slot is used, not refused', async () => {
    const w = world()

    await w.actions.createSynced(await w.input({ reportedLimit: 1 }), { name: 'Neu' })

    expect(w.created).toHaveLength(1)
    // The local-only stage and the server project are one project, counted once.
    expect(projectsModel(await w.input({ reportedLimit: 1 })).ownedCount).toBe(1)
  })

  it('refuses at the limit before creating anything here', async () => {
    const w = world()
    await w.localProject('Alpha')
    const before = await w.cache.readLocalProjects()

    expect(
      await refusal(w.actions.createSynced(await w.input({ reportedLimit: 1 }), { name: 'Neu' })),
    ).toBe('limit')

    expect(await w.cache.readLocalProjects()).toEqual(before)
    expect(w.created).toEqual([])
  })

  it('refuses when the model would not create on the server', async () => {
    const w = world()

    expect(
      await refusal(w.actions.createSynced(await w.input({ plan: 'free' }), { name: 'Neu' })),
    ).toBe('not-applicable')
    expect(await w.cache.readLocalProjects()).toEqual([])
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
    expect(await w.count(alpha.dbName)).toBe(4)
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
    // The owner keeps working on the copy; its edits go up once it is put back.
    expect((await w.view(bravo.dbName)).row).toMatchObject({ location: 'local', editable: true })
    expect(w.state.refreshed).toBe(1)
  })
})

describe('putting a removed project back on the server', () => {
  /** A synchronized project, then removed from the server: its copy stays here, read-only. */
  const removed = async (w: ReturnType<typeof world>) => {
    const bravo = await w.syncedProject()
    const first = await w.view(bravo.dbName)
    await w.actions.removeFromServer(first.model, first.row)
    w.updated.length = 0
    w.sets.length = 0
    w.log.length = 0
    w.state.refreshed = 0
    return bravo
  }

  it('unarchives it, synchronizes the copy again and keeps its data', async () => {
    const w = world()
    const bravo = await removed(w)
    const { model, row } = await w.view(bravo.dbName)
    expect(row.actions.restore).toEqual({ allowed: true })

    await w.actions.restore(model, row)

    expect(w.updated).toEqual([[bravo.projectId, { archived: false }]])
    // Handed to replication at once, so whatever the copy holds goes up.
    expect(w.sets.at(-1)).toEqual([{ projectId: bravo.projectId, dbName: bravo.dbName }])
    expect(await w.count(bravo.dbName)).toBe(1)
    expect((await w.view(bravo.dbName)).row).toMatchObject({
      location: 'synced',
      archived: false,
      editable: true,
    })
    expect(w.state.refreshed).toBe(1)
  })

  it('holds the tab busy while it works, and lets go before refreshing', async () => {
    const w = world()
    const bravo = await removed(w)
    const { model, row } = await w.view(bravo.dbName)
    const seen: boolean[] = []
    // A shell refresh between the unarchive and the hand-over could replace the replication list.
    const set = w.deps.sync.set
    w.deps.sync.set = (projects) => {
      seen.push(projectActionRunning())
      set(projects)
    }
    w.state.onRefresh = () => seen.push(projectActionRunning())

    await w.actions.restore(model, row)

    expect(seen).toEqual([true, false])
  })

  it('says why the server refused, and leaves the copy as it was', async () => {
    const w = world()
    const bravo = await removed(w)
    const { model, row } = await w.view(bravo.dbName)

    w.state.updateFails = 'project-limit-reached'
    expect(await refusal(w.actions.restore(model, row))).toBe('project-limit-reached')
    w.state.updateFails = 'plan-no-sync'
    expect(await refusal(w.actions.restore(model, row))).toBe('plan-no-sync')
    w.state.updateFails = 'failed'
    expect(await refusal(w.actions.restore(model, row))).toBe('failed')

    expect(w.sets).toEqual([])
    expect((await w.view(bravo.dbName)).row).toMatchObject({ location: 'local', archived: true })
    expect(await w.count(bravo.dbName)).toBe(1)
  })

  it('does not ask the server when the model already refuses', async () => {
    const w = world()
    const bravo = await removed(w)
    w.state.online = false
    const { model, row } = await w.view(bravo.dbName)

    expect(await refusal(w.actions.restore(model, row))).toBe('offline')
    expect(w.updated).toEqual([])
  })
})

describe('an owner’s orphan, detached (#290)', () => {
  /** A synchronized copy whose server project the server then hard-deleted. */
  const orphaned = async (w: ReturnType<typeof world>) => {
    const project = await w.syncedProject('Bravo')
    // Encrypted, as every server project is since #302: its wrap for this device replicated in.
    // Without one there would be no DEK to make the escrow wrap that promoting it again needs.
    await createProjectKeys(w.database(project.dbName), null)
    // The replicated project document carries the server database's name.
    await w
      .database(project.dbName)
      .put({ _id: PROJECT_DOCUMENT_ID, type: 'project', name: 'Bravo', serverDb: project.dbName })
    w.server.length = 0 // the fresh list no longer names it
    return project
  }

  it('is read-only before the detach, an ordinary local project after it', async () => {
    const w = world()
    const project = await orphaned(w)
    const before = await w.view(project.dbName)
    expect(before.row).toMatchObject({ location: 'local', editable: false })
    expect(before.row.actions.rename).toMatchObject({ allowed: false })
    expect(before.row.actions.promote).toMatchObject({ allowed: false })

    const entry = await detachOrphanedProject(project.dbName, w.deps.local)

    if (entry === undefined) throw new Error('the detach yielded, with no other tab around')
    const { row } = await w.view(entry.dbName)
    expect(row).toMatchObject({ location: 'local', editable: true })
    expect(row.projectId).toBeUndefined()
    expect(row.actions.rename).toEqual({ allowed: true })
    expect(row.actions.promote).toEqual({ allowed: true })
    await renameLocalProject(entry.dbName, 'Bravo again', w.deps.local)
    expect((await w.view(entry.dbName)).row.name).toBe('Bravo again')
  })

  it('promotes as a new server project, whose devices arrive there', async () => {
    const w = world()
    const project = await orphaned(w)
    const entry = await detachOrphanedProject(project.dbName, w.deps.local)
    if (entry === undefined) throw new Error('the detach yielded, with no other tab around')

    const { model, row } = await w.view(entry.dbName)
    await w.actions.promote(model, row)

    // A genuinely new `POST /projects` — the detached entry carries no id to reuse, so `target`
    // creates rather than looks up — and nothing is patched or unarchived. (The fake server's
    // ids restart per world, so the old and new id are not comparable here; the request log is.)
    expect(w.created).toEqual([{ name: 'Bravo', escrowWrap: expect.any(Object) }])
    expect(w.updated).toEqual([])
    const recreated = w.server[0]
    if (recreated === undefined) throw new Error('no server project was created')
    expect(w.pushes).toContain(recreated.projectId)
    // The device and both wraps went with it; the detached copy's own project document did not.
    await expect(w.database(recreated.dbName).get('device:copy')).resolves.toMatchObject({
      type: 'device',
    })
    expect(await w.count(recreated.dbName)).toBe(3)
    // The index lists only the new server copy; the detached database finished its promotion.
    expect((await w.cache.readLocalProjects()).map((e) => e.dbName)).toEqual([recreated.dbName])
  })
})

describe('coordination across tabs (#220)', () => {
  /**
   * A second tab's handle on the same store, writing the way the application writes: through
   * the shared write lock `openHandle` puts on every project database. Web Locks are origin
   * wide, so another holder in this page contends exactly as another tab would.
   */
  const secondTab = (dbName: string): PouchDB.Database => {
    touched.add(dbName)
    return coordinateWrites(dbName, new PouchDB(dbName))
  }

  it('removing the local copy: a second tab cannot write between the final check and the destroy', async () => {
    const w = world()
    const bravo = await w.syncedProject()
    const tabB = secondTab(bravo.dbName)
    await tabB.info() // the connection is open, as a tab with the project open holds one

    let outcome: Promise<'landed' | 'refused'> | undefined
    let docsAtDestroy = -1
    w.state.beforeDestroy = async () => {
      w.state.beforeDestroy = undefined
      // The final update_seq check has passed. The other tab writes now — the #220 window.
      outcome = tabB.put(device('device:late')).then(
        () => 'landed' as const,
        () => 'refused' as const,
      )
      // Plenty of macrotasks: uncoordinated, the write lands here and is then destroyed with
      // the database; coordinated, it must still be waiting when the destroy proceeds.
      // Counted through the world's live handle: a fresh handle would share (and then close)
      // PouchDB's one cached connection per name, under the destroy being tested.
      for (let i = 0; i < 20; i += 1) await new Promise((resolve) => setTimeout(resolve, 5))
      docsAtDestroy = await w.count(bravo.dbName)
    }
    const { model, row } = await w.view(bravo.dbName)

    await w.actions.removeLocalCopy(model, row)

    // Nothing landed between the check and the destroy: what was verified is what was destroyed.
    expect(docsAtDestroy).toBe(1)
    // And the write was not lost silently: held off past the destroy, it was refused where the
    // other tab can see it, not swallowed with the database.
    expect(await outcome).toBe('refused')
    await tabB.close().catch(() => undefined)
  })

  it('promoting: a second tab cannot write between the final check and the destroy', async () => {
    const w = world()
    const alpha = await w.localProject()
    const tabB = secondTab(alpha.dbName)
    await tabB.info()

    let outcome: Promise<'landed' | 'refused'> | undefined
    let docsAtDestroy = -1
    w.state.beforeDestroy = async () => {
      w.state.beforeDestroy = undefined
      outcome = tabB.put(device('device:late')).then(
        () => 'landed' as const,
        () => 'refused' as const,
      )
      for (let i = 0; i < 20; i += 1) await new Promise((resolve) => setTimeout(resolve, 5))
      docsAtDestroy = await w.count(alpha.dbName)
    }
    const { model, row } = await w.view(alpha.dbName)

    await w.actions.promote(model, row)

    // The project document, both key wraps and two devices the check verified — not one more.
    // The escrow wrap was written before the transfer's first `update_seq`, so it is part of
    // what the check saw rather than a write that trips it (#305).
    expect(docsAtDestroy).toBe(5)
    expect(await outcome).toBe('refused')
    // The verified copy is untouched by any of it.
    const [project] = w.server as [Project]
    expect((await w.database(project.dbName).allDocs()).rows).toHaveLength(4)
    await tabB.close().catch(() => undefined)
  })
})
