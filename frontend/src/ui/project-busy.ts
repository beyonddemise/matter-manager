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
 * listeners hear it once and apply what they skipped. A read that *spans* an action — begun
 * before it, finished after — is told apart by {@link projectActionEpoch} and dropped.
 *
 * Module state, like the open project itself (`db/project-database.ts`): both describe this tab,
 * and the actions and the shell reach them without being wired to each other.
 *
 * @module
 */

let running = 0
/** Moves whenever an action begins or ends; see {@link projectActionEpoch}. */
let epoch = 0
const idleListeners = new Set<() => void>()

/**
 * Marks a project action as running.
 *
 * @returns the function that marks it finished; calling it more than once does nothing more
 */
export function beginProjectAction(): () => void {
  running += 1
  epoch += 1
  let ended = false
  return () => {
    if (ended) return
    ended = true
    running -= 1
    // Before the listeners: the refresh they start must read under the new number, and any read
    // still in flight from inside the action must find it moved.
    epoch += 1
    if (running === 0) for (const listener of [...idleListeners]) listener()
  }
}

/**
 * A number that moves each time a project action begins or ends.
 *
 * **Why.** "Is an action running" only describes the present. A read that began before an action
 * (or during one) and finishes after it ended sees nothing running, yet what it read is what the
 * action was changing — applying it would reopen the database the action left and hand
 * replication the copy it removed. A read that captures this before it starts, and finds it moved
 * when it finishes, knows an action began or ended in between, and that the idle refresh is
 * bringing the facts that count. Moving on the end too is what catches the read begun mid-action.
 */
export function projectActionEpoch(): number {
  return epoch
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
