/**
 * Which projects are replicating, and keeping that list right as it changes.
 *
 * One replication per project, started when the project appears and stopped when it goes away.
 * "Goes away" is the case worth stating: a project somebody has just been removed from must
 * stop replicating, or this browser keeps a live connection to a database it may no longer
 * read — CouchDB will refuse it, and the interface will show a project that is permanently
 * "offline" rather than one that is gone.
 *
 * @module
 */

import { replicateProject, type SyncHandle, type SyncState } from './replication.js'

/** The projects to replicate, as `GET /projects` describes them. */
export interface SyncableProject {
  readonly projectId: string
  readonly dbName: string
}

/** What the manager needs. Everything that touches a database is injected. */
export interface ManagerDependencies {
  /** Opens this browser's copy of a project. */
  readonly local: (dbName: string) => Parameters<typeof replicateProject>[0]
  /** Opens the server's copy. */
  readonly remote: (dbName: string) => Parameters<typeof replicateProject>[1]
  /** Called when any project's state changes, so an interface can show a summary. */
  readonly onState?: (projectId: string, state: SyncState) => void
  /** Called when documents arrive for a project, so a view showing it can re-read. */
  readonly onIncoming?: (projectId: string) => void
}

/** Replications, by project. */
export interface SyncManager {
  /**
   * Makes the running replications match this list exactly.
   *
   * Idempotent: called with the same list twice, the second call does nothing. That matters
   * because the list is re-fetched whenever connectivity returns, and restarting every
   * replication on every reconnection would throw away the checkpoint each one is holding.
   */
  set(projects: readonly SyncableProject[]): void
  /** The projects currently replicating. */
  running(): readonly string[]
  /** What one project's replication is doing, or `undefined` if it is not running. */
  stateOf(projectId: string): SyncState | undefined
  /** Stops everything. For signing out, and for a page being torn down. */
  stopAll(): void
}

/** Builds a manager. Nothing replicates until {@link SyncManager.set} is called. */
export function syncManager(deps: ManagerDependencies): SyncManager {
  const handles = new Map<string, SyncHandle>()
  const states = new Map<string, SyncState>()

  const startOne = (project: SyncableProject): void => {
    const handle = replicateProject(deps.local(project.dbName), deps.remote(project.dbName), {
      onState: (state) => {
        states.set(project.projectId, state)
        deps.onState?.(project.projectId, state)
      },
      onIncoming: () => deps.onIncoming?.(project.projectId),
    })
    handles.set(project.projectId, handle)
  }

  const stopOne = (projectId: string): void => {
    handles.get(projectId)?.cancel()
    handles.delete(projectId)
    states.delete(projectId)
  }

  return {
    set(projects: readonly SyncableProject[]): void {
      const wanted = new Map(projects.map((project) => [project.projectId, project]))

      // Stopped first. A project that has gone is one this browser may no longer be allowed to
      // read, and leaving its replication running for even the length of this function is a
      // connection to a database somebody has just been removed from.
      for (const projectId of [...handles.keys()]) {
        if (!wanted.has(projectId)) stopOne(projectId)
      }

      for (const [projectId, project] of wanted) {
        // Already running: left alone, rather than restarted. Restarting would discard the
        // checkpoint and re-scan the whole database — on every reconnection, which is exactly
        // when the connection is worst.
        if (handles.has(projectId)) continue
        startOne(project)
      }
    },

    running: () => [...handles.keys()],

    stateOf: (projectId) => states.get(projectId),

    stopAll(): void {
      for (const projectId of [...handles.keys()]) stopOne(projectId)
    },
  }
}
