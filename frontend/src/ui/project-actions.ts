/**
 * Promoting, downloading, removing and putting back projects: the projects page's actions that
 * move data.
 *
 * **Data safety decides every order here.** Nothing is destroyed until the data is provably
 * somewhere else — a push that resolved, which `SyncManager.pushNow` only does once the server
 * has every document — except by the one explicit act that means to destroy it: deleting a
 * local-only project after typing its name. Two more rules close the gap between "pushed" and
 * "destroyed": the views move off a database *before* it is copied or pushed, so this tab's
 * writes land in the survivor; and the database's `update_seq` must be the same after the
 * transfer as before it, or the transfer is repeated once and then refused (`settled`), so a
 * write that lands while the transfer runs is never destroyed unsent. Tabs are coordinated by a
 * Web Lock per database (`db/db-lock.ts`, #220): every write anywhere holds it shared, and the
 * final check with its destroy holds it exclusive, so no tab can write in between. Where the
 * browser has no Web Locks the check alone still bounds the risk to the last round trip.
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
 * **Going to the server carries the escrow wrap (#305).** Before `POST /projects`, promote
 * makes sure the source database holds `key:escrow` — creating it from the project's DEK when
 * the project was born offline — and sends its `{kid, wrapped}` for the server to validate.
 * The DEK is reused (spec decision 8): ciphertext and the `key:*` documents replicate as-is.
 *
 * **Creating a project as synchronized is creating it here, then promoting it (#326).** Every
 * project is born locally (spec decision 9): the local creation mints the DEK and this device's
 * wrap, and the promotion is the one route to the server, so it is the one place an escrow wrap
 * is ensured and sent. There is no second, direct `POST /projects` path to keep in step.
 *
 * @module
 */

import { isLocalOnlyDatabase, type LocalProjectEntry } from '../data/index.js'
import { PROJECT_DOCUMENT_ID } from '../domain/documents/project.js'
import type { CurrentTarget } from './current-project.js'
import { withDestroyLock } from './db/db-lock.js'
import { ensureEscrowWrap } from './db/keyring.js'
import { PROJECT_DATABASE_NAME } from './db/project-database.js'
import type { EscrowKeyInfo } from './escrow-client.js'
import {
  createLocalProject,
  destroyLocalProject,
  indexServerProject,
  type LocalProjectDependencies,
} from './local-projects.js'
import { beginProjectAction } from './project-busy.js'
import {
  createProject,
  type EscrowWrap,
  type NewProject,
  type Project,
  ProjectCreationError,
  type ProjectsApi,
  updateProject,
} from './projects.js'
import {
  type CreateRefusal,
  type Permission,
  type ProjectsInput,
  type ProjectsModel,
  projectsModel,
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
 *
 * Creating a project refuses with the model's own {@link CreateRefusal}s too.
 */
export type ActionRefusal = Refusal | CreateRefusal | 'unpushed' | 'name-mismatch'

/** An action refused, and nothing was destroyed. The view turns the reason into a sentence. */
export class ProjectActionError extends Error {
  override readonly name = 'ProjectActionError'
  readonly reason: ActionRefusal

  constructor(reason: ActionRefusal, options?: { cause?: unknown }) {
    super(`A project action was refused: ${reason}.`, options)
    this.reason = reason
  }
}

/**
 * A project was created on this device, and putting it on the server then failed (#326).
 *
 * Not a refusal: the reader asked for a project and has one. It stays a local-only project —
 * listed, encrypted, offered to synchronize again — and only the server half is missing. The
 * view says both: that it exists here, and why the server half did not happen ({@link cause}).
 */
export class CreatedLocallyError extends Error {
  override readonly name = 'CreatedLocallyError'
  /** The project that was created, as the index lists it. */
  readonly entry: LocalProjectEntry

  constructor(entry: LocalProjectEntry, cause: unknown) {
    super('A project was created on this device but could not be put on the server.', { cause })
    this.entry = entry
  }
}

/** What the actions need of replication. */
export type ActionSync = Pick<SyncManager, 'set' | 'pushNow' | 'suspend' | 'resume'>

export type { CurrentTarget }

/**
 * Where promote finds the escrow public key to wrap a project's DEK for: the copy `mm-local`
 * cached at startup first, then `GET /escrowkey`. Both answer `null` for "none": nothing
 * cached, or a 404 from a server with the feature off.
 */
export interface EscrowKeySource {
  /** `cachedEscrowKey` over `mm-local`: never throws, never fetches. */
  readonly cached: () => Promise<EscrowKeyInfo | null>
  /** `escrowApi(...).fetchEscrowKey`: `null` on a 404, throws on any other failure. */
  readonly fetch: () => Promise<EscrowKeyInfo | null>
}

/** Everything the actions touch. */
export interface ProjectActionDependencies {
  readonly api: ProjectsApi
  /** Whether the browser believes it is online; trusted only when it says no. */
  readonly online: () => boolean
  /** The escrow public key, for the wrap provisioning sends (#305). */
  readonly escrowKey: EscrowKeySource
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
  /**
   * Creates a project where the model sends it to the server: on this device first, then
   * promoted (#326). Given the inputs rather than a model, because the promotion needs the row
   * of a project that did not exist when the page rendered.
   *
   * @throws {ProjectActionError} the model's refusal, `not-applicable` when the model would
   *   create locally, before anything is created
   * @throws {ProjectCreationError} `offline` before anything is created
   * @throws {CreatedLocallyError} when the project was created here and the promotion failed
   */
  createSynced(input: ProjectsInput, request: NewProject): Promise<void>
  /** Puts a local-only project on the server, or finishes a promotion that stopped half way. */
  promote(model: ProjectsModel, row: Row): Promise<void>
  /** Starts keeping a local copy of a server-only project. */
  download(model: ProjectsModel, row: Row): Promise<void>
  /** Drops the local copy of a synchronized project, once a push proved the server has it all. */
  removeLocalCopy(model: ProjectsModel, row: Row): Promise<void>
  /** Destroys a local database that has nowhere else to go, given its exact name. */
  deleteLocalProject(model: ProjectsModel, row: Row, typedName: string): Promise<void>
  /** Archives the project on the server. The owner's local copy stays, and stays editable. */
  removeFromServer(model: ProjectsModel, row: Row): Promise<void>
  /** Unarchives the project a removed copy belongs to, and synchronizes the copy again. */
  restore(model: ProjectsModel, row: Row): Promise<void>
}

/** Refuses with the model's reason when it does not allow the action. */
function ensure(permission: Permission<ActionRefusal>): void {
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
 * and runs `finish` (the destroy, and whatever bookkeeping must precede it) only if the database
 * did not change while the transfer ran.
 *
 * **Why.** A copy or a push proves what was there when it *started*. Anything written after
 * that (another tab, a conflict resolver, a write that raced the switch away) would go with the
 * destroy that follows. `update_seq` moves on every write, so an unchanged one before and after
 * proves the transfer saw everything. A change is given one more transfer; a database still
 * being written to after that is refused, and refusing keeps it.
 *
 * The final check and `finish` run under the database's exclusive Web Lock (#220): every write,
 * in any tab, holds the same lock shared (`db/db-lock.ts`), so nothing can land between the
 * check and the destroy. A write that arrives in that window waits past the destroy and fails
 * where its tab can see it, instead of landing in a database the check just declared fully
 * transferred. The transfer itself runs outside the lock, deliberately — a write during a push
 * should land and be caught by the re-check, not stall behind a two-minute hold. Without Web
 * Locks (ruling C-R8) the check alone bounds the risk to the last round trip, as before.
 */
async function settled(
  source: PouchDB.Database,
  dbName: string,
  transfer: () => Promise<void>,
  finish: () => Promise<void>,
): Promise<void> {
  for (let attempt = 0; attempt < TRANSFER_ATTEMPTS; attempt += 1) {
    const before = (await source.info()).update_seq
    await transfer()
    const finished = await withDestroyLock(dbName, async () => {
      if ((await source.info()).update_seq !== before) return false
      await finish()
      return true
    })
    if (finished) return
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
   * The escrow public key provisioning wraps for: the cached one, else the server's.
   *
   * Provisioning is online by definition (ADR 0003), so the fallback fetch is always possible
   * here, unlike at offline creation. Its failures are creation failures, so the page says them
   * the way it says every other reason `POST /projects` did not happen.
   *
   * @throws {ProjectCreationError} `escrow-unavailable` when the server has no escrow key (404),
   *   `unreachable` when the request did not arrive, `failed` for any other answer
   */
  const escrowKey = async (): Promise<EscrowKeyInfo> => {
    const cached = await deps.escrowKey.cached()
    if (cached !== null) return cached
    let fetched: EscrowKeyInfo | null
    try {
      fetched = await deps.escrowKey.fetch()
    } catch (error) {
      // A `TypeError` is `fetch` never reaching the server; see `createProject` on why that is
      // not `offline`.
      throw new ProjectCreationError(error instanceof TypeError ? 'unreachable' : 'failed')
    }
    if (fetched === null) throw new ProjectCreationError('escrow-unavailable')
    return fetched
  }

  /**
   * The escrow wrap `POST /projects` sends, ensured in the source database first (#305).
   *
   * **Why here, before anything else touches the source.** It is the one write promote makes
   * to the database it is about to destroy, and it lands before `settled` reads its first
   * `update_seq`: the transfer copies it like every other document, and the final check under
   * the exclusive lock sees an unchanged sequence. Written any later — after a transfer had
   * started — it would trip that check and refuse the promotion as "still being written to".
   * It takes only the ordinary shared write lock (the handle's `bulkDocs`), and no exclusive
   * lock is held at this point, so it cannot wait on itself.
   *
   * Idempotent: a project born with the escrow key cached already has the wrap, which is sent
   * as stored. A wrap written here for a creation the server then refuses stays: it is the
   * project's own and the next attempt sends it again.
   *
   * @throws {ProjectCreationError} `offline` before anything is asked, or as {@link escrowKey}
   */
  const provisioningWrap = async (dbName: string): Promise<EscrowWrap> => {
    // Asked first, so an offline device neither fetches nor writes a wrap it cannot send.
    if (!deps.online()) throw new ProjectCreationError('offline')
    return ensureEscrowWrap(local.database(dbName), await escrowKey())
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
    const escrowWrap = await provisioningWrap(row.dbName)
    const created = await createProject(serverDeps, {
      name: entry.name,
      ...(entry.client === undefined ? {} : { client: entry.client }),
      escrowWrap,
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

  /** See {@link ProjectActions.promote}. */
  const promote = (model: ProjectsModel, row: Row): Promise<void> =>
    held(async () => {
      ensure(row.actions.promote)
      const project = await target(row)
      const source = local.database(row.dbName)
      const survivor = local.database(project.dbName)

      // Started first, because `pushNow` only pushes projects it has been given.
      sync.set(replicated(model, { add: { projectId: project.projectId, dbName: project.dbName } }))
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
      // Whether the destroy itself was reached: its failure must not move the views back to a
      // half-removed database, nor copy into one, so the catch below leaves it alone.
      let destroying = false
      try {
        await settled(
          source,
          row.dbName,
          // Into the server-named database (ruling C-R1), so live sync pairs it with its
          // server namesake. Without the `project` document: on a server database the service
          // owns it, and it arrives by replication. Copying again copies only what is missing.
          async () => {
            const copied = await source.replicate.to(survivor, {
              filter: (doc: { _id: string }) => doc._id !== PROJECT_DOCUMENT_ID,
            })
            if (copied.doc_write_failures > 0) {
              throw new Error(`${copied.doc_write_failures} documents could not be copied.`)
            }
            await push(project.projectId)
          },
          async () => {
            // The server has everything the old database ever held. Only now is it
            // expendable. Listed after the check, not inside the transfer: a transfer that is
            // then refused must leave no entry for a copy that is not finished. It writes
            // `mm-local`, not the source, so it cannot disturb the check it follows.
            await indexServerProject(project, local)
            destroying = true
            await destroyLocalProject(row.dbName, local)
          },
        )
      } catch (error) {
        if (!destroying) {
          // Ruling C-R11. The views have been writing into the survivor since `leave`, and a
          // refusal leaves it unlisted: copied back before the views return, so nothing this
          // tab wrote during the transfer is stranded where no entry names it. Without the
          // `project` document, which the source keeps as its own. A copy that fails here does
          // not hide the refusal: the survivor still holds those writes, and a retry copies
          // into it again.
          await survivor.replicate
            .to(source, { filter: (doc: { _id: string }) => doc._id !== PROJECT_DOCUMENT_ID })
            .catch(() => undefined)
          back()
        }
        throw error
      }
    })

  /**
   * See {@link ProjectActions.createSynced}.
   *
   * **Why the order.** The model's permission and the connection are asked before anything is
   * written, so a refusal leaves nothing behind, as the direct `POST /projects` did. Once the
   * local project exists it is the reader's: a promotion that fails afterwards — the escrow
   * feature off, the server unreachable, a push cut short — keeps it, local-only and offered to
   * synchronize again, and says so ({@link CreatedLocallyError}). Rolling it back would
   * destroy a project the reader asked for, to undo a failure that was only the server's half.
   *
   * **Why the limit holds.** The model counts a local-only project and its synchronized
   * successor as one owned project, and `POST /projects` counts only the server's, so the
   * promotion neither double-counts nor slips past it: creating needs a free slot, and the
   * promotion's own limit check then sees exactly the count the creation made.
   */
  const createSynced = async (input: ProjectsInput, request: NewProject): Promise<void> => {
    const model = projectsModel(input)
    ensure(model.canCreate)
    if (model.createTarget !== 'synced') throw new ProjectActionError('not-applicable')
    if (!deps.online()) throw new ProjectCreationError('offline')

    const entry = await createLocalProject(request, local)
    try {
      // The model with the new project in it: the page's, plus what was just indexed, so the
      // promotion is permitted (or refused) by the same rules as one chosen from the menu.
      const after = projectsModel({ ...input, local: [...input.local, entry] })
      const row = after.owned.find((candidate) => candidate.dbName === entry.dbName)
      if (row === undefined) throw new Error(`No row for the new project ${entry.dbName}.`)
      await promote(after, row)
    } catch (error) {
      // A failed promotion does not refresh (`held` refreshes on success only), and the page
      // must list the project that now exists. A refresh that fails too is logged, not thrown:
      // the reader needs to hear about the creation, not about the re-read.
      await deps.refresh().catch((refreshError: unknown) => {
        console.error('The projects page could not be re-read.', refreshError)
      })
      throw new CreatedLocallyError(entry, error)
    }
  }

  return {
    createSynced,
    promote,

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
          // As in promote: a destroy that failed must not send the views back into the remains.
          let destroying = false
          try {
            await settled(
              local.database(row.dbName),
              row.dbName,
              () => push(projectId),
              async () => {
                destroying = true
                await destroyLocalProject(row.dbName, local)
              },
            )
          } catch (error) {
            if (!destroying) back()
            throw error
          }
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
          // Exclusive, like the verified destroys: a write another tab has in flight lands
          // first, and one that arrives during the destroy fails visibly there (#220).
          await withDestroyLock(row.dbName, () => destroyLocalProject(row.dbName, local))
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
        // The local copy stays, editable: the owner's edits wait here until it is put back.
        sync.set(replicated(model, { drop: projectId }))
      }),

    restore: (model, row) =>
      held(async () => {
        ensure(row.actions.restore)
        const { projectId, dbName } = row
        if (projectId === undefined) throw new Error('Not a server project.')
        // Nothing local moves: the copy already carries the server's name and id, so once the
        // server lists the project as active again the page reads it `synced`. The server is
        // asked first, and its refusal (no room, no sync, matrix unreadable) leaves all as it was.
        await updateProject(serverDeps, projectId, { archived: false })
        // The copy may hold what never got through before the archive; replication sends it now.
        // Added here rather than left to the refresh: the model still reads the row `local`.
        sync.set(replicated(model, { add: { projectId, dbName } }))
      }),
  }
}
