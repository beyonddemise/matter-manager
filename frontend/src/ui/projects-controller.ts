/**
 * The shell's projects: what the projects page is computed from, which project is open, and what
 * replicates — kept apart from the shell, which only renders it and says when the session changes.
 *
 * It reads the local index, the server list (this session's, or the last one heard, C-R5) and the
 * cached plan into {@link ProjectsController.facts}; builds the page's `ProjectsInput` from them;
 * and after every read **applies** them: the current project is resolved and opened, and
 * replication is handed the copies on this device. Replication itself — the manager, its states
 * and the per-session guard — lives here too, because applying is what drives it.
 *
 * While a project action runs (`project-busy.ts`) the facts are still read but nothing is
 * applied: the action has switched the project and handed replication a list of its own, and an
 * apply in the middle would undo both. When the last one finishes, everything is read and applied
 * again.
 *
 * @module
 */

import type { ReactiveController, ReactiveControllerHost } from 'lit'
import { DEFAULT_PLAN } from '../domain/plan.js'
import { projectSync, projects } from './composition.js'
import {
  readCurrentProjectId,
  resolveCurrentProject,
  writeCurrentProjectId,
} from './current-project.js'
import { useProjectDatabase } from './db/project-database.js'
import {
  adoptLegacyCatalogue,
  type LocalProjectDependencies,
  localProjectDefaults,
} from './local-projects.js'
import { onProjectActionsIdle, projectActionRunning } from './project-busy.js'
import { fetchProjectList, type ProjectFacts, readProjectFacts } from './project-inputs.js'
import type { Project } from './projects.js'
import { type ProjectsInput, projectsModel, synchronizedProjects } from './projects-model.js'
import type { SessionState } from './session.js'
import type { SyncManager } from './sync/manager.js'
import type { SyncState } from './sync/replication.js'

/** What the controller reads from the shell it serves. */
export interface ProjectsHost extends ReactiveControllerHost {
  /** What the browser believes about the session; `undefined` until the first answer. */
  readonly session: SessionState | undefined
  /** What the browser last said about the network. */
  readonly online: boolean
  /** `GET /projects`; injected by tests. */
  readonly listProjects?: () => Promise<readonly Project[]>
  /** Builds the replication manager; injected by tests. */
  readonly makeSync?: (onState: (id: string, state: SyncState) => void) => SyncManager
  /** The local index and databases; injected by tests. */
  readonly projectStore?: LocalProjectDependencies
}

/** What the page reads before the first read: a device holding nothing yet. */
const NO_FACTS: ProjectFacts = {
  local: [],
  server: undefined,
  serverStale: true,
  plan: DEFAULT_PLAN,
}

/** See the module comment. */
export class ProjectsController implements ReactiveController {
  private readonly host: ProjectsHost

  /** The facts last read; `undefined` until the first read. */
  facts: ProjectFacts | undefined

  /** One replication per project while signed in; `undefined` otherwise. */
  sync: SyncManager | undefined

  /**
   * What replication is doing across every project, or `undefined` when none is running.
   *
   * The worst state wins, because a summary that reported `idle` while one project was
   * unreachable would be reassuring and wrong.
   */
  syncing: SyncState | undefined

  /** Each project's last reported state, for the page's rows and the summary. */
  private readonly states = new Map<string, SyncState>()

  /** This session's `GET /projects`, if it answered. Dropped whenever the session ends. */
  private fresh: readonly Project[] | undefined

  /** The tail of the read queue. */
  private reading: Promise<void> = Promise.resolve()

  /**
   * Counts sessions, so work started under one cannot land under the next. The same guard
   * `theme.ts` uses for stylesheet loads and `device.ts` for saves: ending a session increments
   * it, so everything started before is answered by nobody.
   */
  private sessionGeneration = 0

  private stopListeningForIdle: (() => void) | undefined

  constructor(host: ProjectsHost) {
    this.host = host
    host.addController(this)
  }

  hostConnected(): void {
    // What an action skipped applying, applied once it is done — from a fresh read, because the
    // action has changed the index since the last one.
    this.stopListeningForIdle = onProjectActionsIdle(() => void this.refresh(false))
    // The index, the remembered list and the cached plan, and the first-run catalogue adopted:
    // none of it waits for the session, so the page is right offline from the first render.
    void this.refresh(false)
  }

  hostDisconnected(): void {
    // A replication left running against a detached shell is a request nobody will read.
    this.end()
    this.stopListeningForIdle?.()
    this.stopListeningForIdle = undefined
  }

  /** Whether `generation` (from {@link generation}) is still the current session's. */
  isCurrent(generation: number): boolean {
    return generation === this.sessionGeneration
  }

  /** The current session's generation, for work that outlives a call. */
  get generation(): number {
    return this.sessionGeneration
  }

  /**
   * Starts this session's replication and fetches the list.
   *
   * The manager is built at once, before the list arrives: the projects page needs it to push
   * and hold while promoting and removing, and what it replicates comes from the index, which is
   * already here. A list that cannot be fetched is not reported: the remembered one stands in,
   * and `offline` in the summary is what replication resuming later looks like.
   */
  start(): void {
    const generation = this.sessionGeneration
    this.sync = (this.host.makeSync ?? ((onState) => projectSync(onState)))((projectId, state) => {
      if (generation !== this.sessionGeneration) return
      // A refusal stops that project's replication (spec): retrying a write the server refuses
      // only refuses it again. Cancelling reports `stopped`, which must not overwrite the reason
      // the page shows on the row. The next list handed over (a refresh, a reconnection) starts
      // it again, which is when a changed permission or plan would let it through.
      if (state === 'stopped' && this.states.get(projectId) === 'denied') return
      this.states.set(projectId, state)
      if (state === 'denied') this.sync?.stop(projectId)
      this.syncing = worstOf([...this.states.values()])
      // The page shows each row's state, and the summary changing is not the only change worth
      // a render: one project going from `active` to `idle` leaves it unchanged.
      this.host.requestUpdate()
    })
    void this.refresh(true)
  }

  /**
   * Ends this session's replication: stopped, its states and its list forgotten.
   *
   * The generation moves first, so a startup or a fetch still in flight cannot finish into the
   * session that has just ended. Callers re-read with {@link refresh} once the session has
   * changed.
   */
  end(): void {
    this.sessionGeneration += 1
    this.sync?.stopAll()
    this.sync = undefined
    this.states.clear()
    this.syncing = undefined
    this.fresh = undefined
    this.host.requestUpdate()
  }

  /**
   * The projects page's input, from the facts last read and what the shell knows now.
   *
   * A list is fresh only within the signed-in session that fetched it, so any other session
   * marks it stale whatever the facts say. Before the session's first answer the page is told
   * `checking`, not `signed-out`: the reader may well be signed in, and "Sign in" would be wrong.
   */
  input(): ProjectsInput {
    const facts = this.facts ?? NO_FACTS
    const session = this.host.session ?? 'checking'
    return {
      local: facts.local,
      server: facts.server,
      serverStale: facts.serverStale || session !== 'signed-in',
      plan: facts.plan,
      ...(facts.reportedLimit === undefined ? {} : { reportedLimit: facts.reportedLimit }),
      session,
      online: this.host.online,
      syncStates: (projectId) => this.states.get(projectId),
    }
  }

  /**
   * Reads the projects again and applies them.
   *
   * The fetch runs outside the queue and the read inside it. Reads are local and quick, so
   * queueing them keeps two refreshes from interleaving (the first-run adoption above all); a
   * fetch can take as long as the network likes, and queued it would hold up every later
   * refresh — the one after a sign-out included — behind a request nobody is waiting for.
   *
   * @param fetchList whether to ask the server for the list first (only signed in and online)
   */
  async refresh(fetchList: boolean): Promise<void> {
    const generation = this.sessionGeneration
    if (fetchList && this.host.session === 'signed-in' && this.host.online) {
      const listed = await fetchProjectList(
        this.host.listProjects ?? (() => projects().list()),
        this.store().cache(),
      )
      // A list asked for by a session that has since ended belongs to nobody.
      if (generation !== this.sessionGeneration) return
      // A failed fetch drops the fresh list: the remembered one stands in, stale (C-R5).
      this.fresh = listed
    }
    const read = this.reading.then(() => this.read())
    this.reading = read.catch(() => undefined)
    await read
  }

  /** One queued read: adopt on a first run, read the facts, apply them. */
  private async read(): Promise<void> {
    const generation = this.sessionGeneration
    const store = this.store()
    // Ruling C-R7: a device that has never known a project adopts its catalogue, even empty, so
    // it has one project to name and open. A no-op anywhere else. A failure leaves the page
    // offering to create a project instead, which loses nothing.
    await adoptLegacyCatalogue('', store).catch(() => undefined)
    const facts = await readProjectFacts(
      store.cache(),
      this.host.session === 'signed-in' ? this.fresh : undefined,
    )
    if (generation !== this.sessionGeneration) return
    this.facts = facts
    this.host.requestUpdate()
    this.apply()
  }

  /**
   * Opens the current project and hands replication its list, both from the page's model, so the
   * shell and the page never disagree about what a project is.
   *
   * Replication gets **only the copies on this device** (`synchronizedProjects`), never every
   * server project: one listed but not downloaded would be downloaded, a copy just removed
   * downloaded again. A project an action holds (`SyncManager.suspend`) stays held whatever this
   * list says. States of projects no longer handed over are forgotten, so a dropped project
   * cannot hold the summary at its last word.
   *
   * Skipped entirely while a project action runs; see the module comment.
   */
  private apply(): void {
    if (projectActionRunning()) return
    const model = projectsModel(this.input())
    const stored = readCurrentProjectId(() => localStorage)
    const current = resolveCurrentProject(stored, model)
    // The *choice* is corrected too, not only the database: a stored id that matches nothing
    // would be re-resolved, and fall back again, on every load.
    if (current.id !== stored) writeCurrentProjectId(() => localStorage, current.id)
    useProjectDatabase(current.dbName, current.editable)
    if (this.sync === undefined) return
    const replicated = synchronizedProjects(model)
    this.sync.set(replicated)
    const kept = new Set(replicated.map((project) => project.projectId))
    for (const projectId of [...this.states.keys()]) {
      if (!kept.has(projectId)) this.states.delete(projectId)
    }
    this.syncing = worstOf([...this.states.values()])
    this.host.requestUpdate()
  }

  /** The local index and databases, the injected ones or the application's. */
  private store(): LocalProjectDependencies {
    return this.host.projectStore ?? localProjectDefaults
  }
}

/**
 * The state worth reporting when several replications disagree.
 *
 * Worst wins. A summary saying `idle` while one project cannot reach the server would be
 * reassuring and wrong, and the reader's question is "is everything through?" rather than "is
 * anything through?". `denied` outranks `offline`: offline heals itself, a refusal does not.
 */
function worstOf(states: readonly SyncState[]): SyncState | undefined {
  const order: readonly SyncState[] = ['denied', 'offline', 'stopped', 'active', 'idle']
  return order.find((state) => states.includes(state))
}
