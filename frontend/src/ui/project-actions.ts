/**
 * Promoting, downloading and removing projects: the projects page's actions that move data.
 *
 * **Data safety decides every order here.** Nothing is destroyed until the data is provably
 * somewhere else — a push that resolved, which `SyncManager.pushNow` only does once the server
 * has every document — except by the one explicit act that means to destroy it: deleting a
 * local-only project after typing its name.
 *
 * Pure orchestration over injected dependencies: the server, replication, the local index and
 * databases, which project is open, and the page's refresh. The browser tests run it on real
 * PouchDB databases with a fake server and replication, and fail it at every step.
 *
 * Every action first asks the row's model permission (`projects-model.ts`) and refuses with its
 * reason, because the page's inputs can change between rendering a menu and choosing from it.
 * After a change the page's inputs are re-read through `refresh`, never patched here.
 *
 * Replication is always handed **every** synchronized project, never just the one that changed:
 * `SyncManager.set` makes the running set match its argument exactly.
 *
 * @module
 */

import { PROJECT_DOCUMENT_ID } from '../domain/documents/project.js'
import { PROJECT_DATABASE_NAME } from './db/project-database.js'
import {
  destroyLocalProject,
  indexServerProject,
  type LocalProjectDependencies,
} from './local-projects.js'
import {
  createProject,
  type Project,
  ProjectCreationError,
  type ProjectsApi,
  updateProject,
} from './projects.js'
import type { Permission, ProjectsModel, Refusal, Row } from './projects-model.js'
import type { SyncableProject, SyncManager } from './sync/manager.js'

/**
 * Why an action refused, besides the model's own reasons.
 *
 * - `unpushed`: the push that must precede removing a local copy did not get everything to the
 *   server, so the copy was kept.
 * - `name-mismatch`: a delete was asked for without typing the project's exact name.
 */
export type ActionRefusal = Refusal | 'unpushed' | 'name-mismatch'

/** An action refused, and nothing was destroyed. The view turns the reason into a sentence. */
export class ProjectActionError extends Error {
  override readonly name = 'ProjectActionError'
  readonly reason: ActionRefusal

  constructor(reason: ActionRefusal, options?: { cause?: unknown }) {
    super(`A project action was refused: ${reason}.`, options)
    this.reason = reason
  }
}

/** What the actions need of replication. */
export type ActionSync = Pick<SyncManager, 'set' | 'pushNow' | 'suspend' | 'resume'>

/** Which project to make current, and how to open it. */
export interface CurrentTarget {
  readonly dbName: string
  /** What the current-project choice remembers: the project id, or the name while local-only. */
  readonly id: string
  readonly editable: boolean
}

/** Everything the actions touch. */
export interface ProjectActionDependencies {
  readonly api: ProjectsApi
  /** Whether the browser believes it is online; trusted only when it says no. */
  readonly online: () => boolean
  readonly sync: ActionSync
  /** The local index and databases, as `local-projects.ts` takes them. */
  readonly local: LocalProjectDependencies
  /** The database the views are reading now. */
  readonly currentDatabase: () => string
  /** Makes another project current; what the page's Open does, without navigating. */
  readonly switchTo: (target: CurrentTarget) => void
  /** Re-reads the page's inputs. */
  readonly refresh: () => Promise<void>
}

/** The actions, each given the model the page rendered and the row it was chosen on. */
export interface ProjectActions {
  /** Puts a local-only project on the server, or finishes a promotion that stopped half way. */
  promote(model: ProjectsModel, row: Row): Promise<void>
  /** Starts keeping a local copy of a server-only project. */
  download(model: ProjectsModel, row: Row): Promise<void>
  /** Drops the local copy of a synchronized project, once a push proved the server has it all. */
  removeLocalCopy(model: ProjectsModel, row: Row): Promise<void>
  /** Destroys a local database that has nowhere else to go, given its exact name. */
  deleteLocalProject(model: ProjectsModel, row: Row, typedName: string): Promise<void>
  /** Archives the project on the server. A local copy stays, read-only. */
  removeFromServer(model: ProjectsModel, row: Row): Promise<void>
}

/** Refuses with the model's reason when it does not allow the action. */
function ensure(permission: Permission): void {
  if (!permission.allowed) throw new ProjectActionError(permission.reason ?? 'not-applicable')
}

/**
 * Every synchronized project the page knows of, with `add` added and `drop` left out.
 *
 * Built from the rows rather than kept anywhere, so it is what the page shows: a project being
 * promoted, removed or archived reads `local` and is left out without being named.
 */
function replicated(
  model: ProjectsModel,
  change: { readonly add?: SyncableProject; readonly drop?: string },
): SyncableProject[] {
  const known = [...model.owned, ...model.shared].flatMap((row) =>
    row.location === 'synced' && row.projectId !== undefined && row.projectId !== change.drop
      ? [{ projectId: row.projectId, dbName: row.dbName }]
      : [],
  )
  const { add } = change
  return add === undefined || known.some((project) => project.projectId === add.projectId)
    ? known
    : [...known, add]
}

/**
 * Where the views go when the open project is about to be destroyed: the first other project
 * on this device — local-only ones first, since they are always editable — or else the local
 * catalogue, which every device has.
 */
function elsewhere(model: ProjectsModel, leaving: string): CurrentTarget {
  const candidates = [...model.owned, ...model.shared].filter(
    (row) => row.dbName !== leaving && row.location !== 'server',
  )
  const next = candidates.find((row) => row.projectId === undefined) ?? candidates[0]
  if (next === undefined) {
    return { dbName: PROJECT_DATABASE_NAME, id: PROJECT_DATABASE_NAME, editable: true }
  }
  return { dbName: next.dbName, id: next.projectId ?? next.dbName, editable: next.editable }
}

/**
 * How long promoting or removing waits for its push. Without a bound a stalled connection would
 * leave the page busy for good; a push cut short is a failure, and a failure keeps the data.
 */
const PUSH_TIMEOUT_MS = 120_000

/** Builds the actions over their dependencies. */
export function projectActions(deps: ProjectActionDependencies): ProjectActions {
  const { sync, local } = deps
  const serverDeps = { api: deps.api, online: deps.online }

  /** Moves the views off a database before it is destroyed: they hold its handle. */
  const leave = (model: ProjectsModel, dbName: string): void => {
    if (deps.currentDatabase() === dbName) deps.switchTo(elsewhere(model, dbName))
  }

  /**
   * The server project a promotion is moving into: the one recorded on the entry if the server
   * still lists it, otherwise a new one, whose id is recorded at once.
   *
   * Recording the id the moment `POST /projects` answers is what makes a retry safe: every
   * later step can fail, and the retry finds the id and does not create a second project. A
   * recorded id the server no longer lists is a project that is gone (or no longer the
   * caller's), which nothing could be pushed into, so a new one is made.
   */
  const target = async (row: Row): Promise<Project> => {
    const entry = (await local.cache().readLocalProjects()).find((e) => e.dbName === row.dbName)
    if (entry === undefined) throw new Error(`No local project is indexed as ${row.dbName}.`)
    if (entry.projectId !== undefined) {
      if (!deps.online()) throw new ProjectActionError('offline')
      let listed: readonly Project[]
      try {
        listed = await deps.api.list()
      } catch (error) {
        if (error instanceof ProjectCreationError) throw error
        throw new ProjectCreationError('unreachable')
      }
      const existing = listed.find((project) => project.projectId === entry.projectId)
      if (existing !== undefined) return existing
    }
    const created = await createProject(serverDeps, {
      name: entry.name,
      ...(entry.client === undefined ? {} : { client: entry.client }),
    })
    await local.cache().updateLocalProject(row.dbName, { projectId: created.projectId })
    return created
  }

  return {
    async promote(model, row) {
      ensure(row.actions.promote)
      const project = await target(row)

      // Into the server-named database (ruling C-R1), so live sync pairs it with its server
      // namesake. Without the `project` document: on a server database the service owns it, and
      // it arrives by replication. Replicating again after a failure copies only what is missing.
      const result = await local.database(row.dbName).replicate.to(local.database(project.dbName), {
        filter: (doc: { _id: string }) => doc._id !== PROJECT_DOCUMENT_ID,
      })
      if (result.doc_write_failures > 0) {
        throw new Error(`${result.doc_write_failures} documents could not be copied.`)
      }

      // Started before the push, because `pushNow` only pushes projects it has been given.
      const synced = { projectId: project.projectId, dbName: project.dbName }
      sync.set(replicated(model, { add: synced }))
      await sync.pushNow(project.projectId, { signal: AbortSignal.timeout(PUSH_TIMEOUT_MS) })

      // The push resolved: the server has everything. Only now is the old database expendable.
      await indexServerProject({ ...project, role: 'owner' }, local)
      if (deps.currentDatabase() === row.dbName) {
        deps.switchTo({ dbName: project.dbName, id: project.projectId, editable: true })
      }
      await destroyLocalProject(row.dbName, local)
      await deps.refresh()
    },

    async download(model, row) {
      ensure(row.actions.download)
      const { projectId, dbName, name, client, role } = row
      if (projectId === undefined || role === undefined) throw new Error('Not a server project.')
      // The role is recorded so an offline device can still tell a share from its own (C-R4).
      await indexServerProject(
        { projectId, dbName, name, role, ...(client === undefined ? {} : { client }) },
        local,
      )
      sync.set(replicated(model, { add: { projectId, dbName } }))
      await deps.refresh()
    },

    async removeLocalCopy(model, row) {
      ensure(row.actions.removeLocal)
      // The model's `online` may be a render old; the browser's own answer is asked again.
      if (!deps.online()) throw new ProjectActionError('offline')
      const { projectId } = row
      if (projectId === undefined) throw new Error('Not a synchronized project.')

      // Held still for the whole removal, so that no reconnection restarts the replication and
      // nothing is written into the copy between the push and the destroy.
      sync.suspend(projectId)
      try {
        try {
          await sync.pushNow(projectId, { signal: AbortSignal.timeout(PUSH_TIMEOUT_MS) })
        } catch (error) {
          throw new ProjectActionError('unpushed', { cause: error })
        }
        leave(model, row.dbName)
        await destroyLocalProject(row.dbName, local)
        // Dropped before the hold is lifted, so lifting it does not start it again.
        sync.set(replicated(model, { drop: projectId }))
      } finally {
        sync.resume(projectId)
      }
      await deps.refresh()
    },

    async deleteLocalProject(model, row, typedName) {
      ensure(row.actions.deleteLocal)
      const name = row.name.trim()
      if (name === '' || typedName.trim() !== name) throw new ProjectActionError('name-mismatch')
      const { projectId } = row
      // A copy that still has a server side (an archived project's, an orphan, a half-done
      // promotion) may still be replicating: held still, then dropped, as for a removal.
      if (projectId !== undefined) sync.suspend(projectId)
      try {
        leave(model, row.dbName)
        await destroyLocalProject(row.dbName, local)
        if (projectId !== undefined) sync.set(replicated(model, { drop: projectId }))
      } finally {
        if (projectId !== undefined) sync.resume(projectId)
      }
      await deps.refresh()
    },

    async removeFromServer(model, row) {
      ensure(row.actions.removeServer)
      const { projectId } = row
      if (projectId === undefined) throw new Error('Not a server project.')
      await updateProject(serverDeps, projectId, { archived: true })
      // The server now refuses every write to it, so replicating it would only report denials.
      // A local copy stays, and the model opens it read-only.
      sync.set(replicated(model, { drop: projectId }))
      await deps.refresh()
    },
  }
}
