/**
 * Promoting, downloading and removing projects: the projects page's actions that move data.
 *
 * **Data safety decides every order here.** Nothing is destroyed until the data is provably
 * somewhere else — a push that resolved, which `SyncManager.pushNow` only does once the server
 * has every document — except by the one explicit act that means to destroy it: deleting a
 * local-only project after typing its name. Two more rules close the gap between "pushed" and
 * "destroyed": the views move off a database *before* it is copied or pushed, so this tab's
 * writes land in the survivor; and the database's `update_seq` must be the same after the
 * transfer as before it, or the transfer is repeated once and then refused (`settled`), so a
 * write that lands while the transfer runs is never destroyed unsent. Tabs are not coordinated:
 * another tab writing in the last round trip before the destroy is the one residual risk (#220).
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

import { isLocalOnlyDatabase } from '../data/index.js'
import { PROJECT_DOCUMENT_ID } from '../domain/documents/project.js'
import type { CurrentTarget } from './current-project.js'
import { PROJECT_DATABASE_NAME } from './db/project-database.js'
import {
  destroyLocalProject,
  indexServerProject,
  type LocalProjectDependencies,
} from './local-projects.js'
import { beginProjectAction } from './project-busy.js'
import {
  createProject,
  type Project,
  ProjectCreationError,
  type ProjectsApi,
  updateProject,
} from './projects.js'
import {
  type Permission,
  type ProjectsModel,
  type Refusal,
  type Row,
  synchronizedProjects,
} from './projects-model.js'
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

export type { CurrentTarget }

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
  const known = synchronizedProjects(model).filter((project) => project.projectId !== change.drop)
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

/** How many times a transfer is repeated because the source changed while it ran. */
const TRANSFER_ATTEMPTS = 2

/**
 * Runs `transfer` — the copy and push that prove a database's contents are safely elsewhere —
 * and resolves only if the database did not change while it ran.
 *
 * **Why.** A copy or a push proves what was there when it *started*. Anything written after
 * that (another tab, a conflict resolver, a write that raced the switch away) would go with the
 * destroy that follows. `update_seq` moves on every write, so an unchanged one before and after
 * proves the transfer saw everything. A change is given one more transfer; a database still
 * being written to after that is refused, and refusing keeps it.
 *
 * The check runs just before the destroy its caller makes next. Between the two there is only
 * bookkeeping that never writes the source — promoting lists the survivor in `mm-local` — so
 * nothing of this page's can write into it there. Another tab still can: nothing coordinates
 * tabs, so a write it lands in that window (a few IndexedDB round trips) is lost with the
 * destroy. A known limit (ruling C-R8), tracked as #220 (Web Locks around these actions).
 */
async function settled(source: PouchDB.Database, transfer: () => Promise<void>): Promise<void> {
  for (let attempt = 0; attempt < TRANSFER_ATTEMPTS; attempt += 1) {
    const before = (await source.info()).update_seq
    await transfer()
    if ((await source.info()).update_seq === before) return
  }
  throw new ProjectActionError('unpushed')
}

/** Builds the actions over their dependencies. */
export function projectActions(deps: ProjectActionDependencies): ProjectActions {
  const { sync, local } = deps
  const serverDeps = { api: deps.api, online: deps.online }

  /**
   * Moves the views off a database that is about to be emptied out, before anything is copied
   * or pushed from it: they hold its handle, and a write this tab makes after the transfer
   * started must land in the database that survives.
   *
   * @returns how to move them back, if the action is refused before the destroy
   */
  const leave = (dbName: string, to: () => CurrentTarget, row: Row): (() => void) => {
    if (deps.currentDatabase() !== dbName) return () => {}
    deps.switchTo(to())
    return () => deps.switchTo({ dbName, id: row.projectId ?? row.dbName, editable: row.editable })
  }

  /** Pushes one project, its failure a refusal: the data is not proven to be on the server. */
  const push = async (projectId: string): Promise<void> => {
    try {
      await sync.pushNow(projectId, { signal: AbortSignal.timeout(PUSH_TIMEOUT_MS) })
    } catch (error) {
      throw new ProjectActionError('unpushed', { cause: error })
    }
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

  /**
   * Runs an action's work while holding `project-busy`, so a shell refresh in the middle cannot
   * switch the open project or hand replication a list of its own (see that module), then
   * refreshes the page's inputs — after letting go, so the refresh is applied in full.
   */
  const held = async (work: () => Promise<void>): Promise<void> => {
    const end = beginProjectAction()
    try {
      await work()
    } finally {
      end()
    }
    await deps.refresh()
  }

  return {
    promote: (model, row) =>
      held(async () => {
        ensure(row.actions.promote)
        const project = await target(row)
        const source = local.database(row.dbName)
        const survivor = local.database(project.dbName)

        // Started first, because `pushNow` only pushes projects it has been given.
        sync.set(
          replicated(model, { add: { projectId: project.projectId, dbName: project.dbName } }),
        )
        // Before the copy, so that every write this tab makes from now on lands in the survivor.
        const back = leave(
          row.dbName,
          () => ({
            dbName: project.dbName,
            id: project.projectId,
            editable: true,
          }),
          row,
        )
        try {
          // Into the server-named database (ruling C-R1), so live sync pairs it with its server
          // namesake. Without the `project` document: on a server database the service owns it,
          // and it arrives by replication. Copying again copies only what is missing.
          await settled(source, async () => {
            const copied = await source.replicate.to(survivor, {
              filter: (doc: { _id: string }) => doc._id !== PROJECT_DOCUMENT_ID,
            })
            if (copied.doc_write_failures > 0) {
              throw new Error(`${copied.doc_write_failures} documents could not be copied.`)
            }
            await push(project.projectId)
          })
          // The server has everything the old database ever held. Only now is it expendable.
          // Listed after the check, not inside the transfer: a transfer that is then refused must
          // leave no entry for a copy that is not finished. It writes `mm-local`, not the source.
          await indexServerProject(project, local)
        } catch (error) {
          back()
          throw error
        }
        await destroyLocalProject(row.dbName, local)
      }),

    download: (model, row) =>
      held(async () => {
        ensure(row.actions.download)
        const { projectId, dbName, name, client, role } = row
        if (projectId === undefined || role === undefined) throw new Error('Not a server project.')
        // The role is recorded so an offline device can still tell a share from its own (C-R4).
        await indexServerProject(
          { projectId, dbName, name, role, ...(client === undefined ? {} : { client }) },
          local,
        )
        sync.set(replicated(model, { add: { projectId, dbName } }))
      }),

    removeLocalCopy: (model, row) =>
      held(async () => {
        ensure(row.actions.removeLocal)
        // The model's `online` may be a render old; the browser's own answer is asked again.
        if (!deps.online()) throw new ProjectActionError('offline')
        const { projectId } = row
        if (projectId === undefined) throw new Error('Not a synchronized project.')

        // Held still for the whole removal, so that no reconnection restarts the replication.
        sync.suspend(projectId)
        try {
          // Off it before the push, so this tab writes nothing into it that the push could miss.
          const back = leave(row.dbName, () => elsewhere(model, row.dbName), row)
          try {
            await settled(local.database(row.dbName), () => push(projectId))
          } catch (error) {
            back()
            throw error
          }
          await destroyLocalProject(row.dbName, local)
          // Dropped before the hold is lifted, so lifting it does not start it again.
          sync.set(replicated(model, { drop: projectId }))
        } finally {
          sync.resume(projectId)
        }
      }),

    deleteLocalProject: (model, row, typedName) =>
      held(async () => {
        ensure(row.actions.deleteLocal)
        const name = row.name.trim()
        if (name === '' || typedName.trim() !== name) throw new ProjectActionError('name-mismatch')
        // A copy of a server project (an archived one's, an orphan) may still be replicating:
        // held still, then dropped, as for a removal. A half-done promotion's id is left alone:
        // what replicates under it is the new server-named copy, not this database.
        const replicating = isLocalOnlyDatabase(row.dbName) ? undefined : row.projectId
        if (replicating !== undefined) sync.suspend(replicating)
        try {
          leave(row.dbName, () => elsewhere(model, row.dbName), row)
          await destroyLocalProject(row.dbName, local)
          if (replicating !== undefined) sync.set(replicated(model, { drop: replicating }))
        } finally {
          if (replicating !== undefined) sync.resume(replicating)
        }
      }),

    removeFromServer: (model, row) =>
      held(async () => {
        ensure(row.actions.removeServer)
        const { projectId } = row
        if (projectId === undefined) throw new Error('Not a server project.')
        // Best effort: once archived the server refuses every write, so whatever the copy has not
        // sent yet never will be. A failure does not stop the archive — the reader asked for it —
        // and the copy left behind warns before it can be deleted (`projects-model.ts`).
        if (row.location === 'synced') await push(projectId).catch(() => undefined)
        await updateProject(serverDeps, projectId, { archived: true })
        // The server now refuses every write to it, so replicating it would only report denials.
        // A local copy stays, and the model opens it read-only.
        sync.set(replicated(model, { drop: projectId }))
      }),
  }
}
