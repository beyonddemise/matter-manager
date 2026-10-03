/**
 * Whether a project action that moves data is running in this tab.
 *
 * Promoting, removing and deleting switch the open project and hand replication a list of their
 * own while they work: the survivor of a promotion is replicating before the index names it, and
 * the views have been moved off a database about to be destroyed. A shell refresh in the middle
 * (the profile landing, a reconnection) recomputes both from the index, and would undo them —
 * reopening the source database, so this tab's next write lands in what is about to be
 * destroyed, and dropping the survivor from replication, so the push the action waits on fails.
 *
 * So the actions hold this while they run, and the shell, while it is held, reads its facts but
 * neither switches the project nor hands replication a list. When the last action lets go,
 * listeners hear it once and apply what they skipped.
 *
 * Module state, like the open project itself (`db/project-database.ts`): both describe this tab,
 * and the actions and the shell reach them without being wired to each other.
 *
 * @module
 */

let running = 0
const idleListeners = new Set<() => void>()

/**
 * Marks a project action as running.
 *
 * @returns the function that marks it finished; calling it more than once does nothing more
 */
export function beginProjectAction(): () => void {
  running += 1
  let ended = false
  return () => {
    if (ended) return
    ended = true
    running -= 1
    if (running === 0) for (const listener of [...idleListeners]) listener()
  }
}

/** Whether any project action is running in this tab. */
export function projectActionRunning(): boolean {
  return running > 0
}

/**
 * Calls `listener` each time the last running action finishes.
 *
 * @returns how to stop listening
 */
export function onProjectActionsIdle(listener: () => void): () => void {
  idleListeners.add(listener)
  return () => {
    idleListeners.delete(listener)
  }
}
