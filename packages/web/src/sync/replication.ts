/**
 * Keeping one project's local database and its CouchDB counterpart in step.
 *
 * **This is the part ADR 0002 refused to hand-roll**, and this module is deliberately thin
 * because of it: revision trees, conflict detection and — the thing the third scenario asks for
 * — *resuming* rather than restarting are PouchDB's, not ours. PouchDB writes a checkpoint
 * document at both ends after each batch, so a sync that is interrupted and started again picks
 * up from the last checkpoint. Nothing here implements that; what is here makes sure it is
 * switched on and that the interface can say what is happening.
 *
 * Lives in `packages/web` rather than `packages/data` for the reason `db/project-database.ts`
 * gives: this is *wiring*, and `packages/data` deliberately imports no PouchDB implementation.
 * It is also why the tests run in a real browser against two real databases — a replication
 * test against a fake proves the fake replicates.
 *
 * @module
 */

/** What replication is doing, in terms an interface can show. */
export type SyncState =
  /** Transferring. */
  | 'active'
  /** Caught up, watching for more. The steady state when everything is fine. */
  | 'idle'
  /**
   * Cannot reach the server, and retrying.
   *
   * **Not an error state.** Being offline is ordinary here, and the local database is complete
   * and usable — so this is worth showing quietly and worth never blocking on.
   */
  | 'offline'
  /** Cancelled. Terminal: a stopped sync does not restart itself. */
  | 'stopped'

/** A running replication. */
export interface SyncHandle {
  /** Stops it. Safe to call more than once, and safe to call on one already stopped. */
  cancel(): void
  /** What it is doing now. */
  state(): SyncState
}

/** What the caller wants to hear about. */
export interface SyncOptions {
  /** Called whenever {@link SyncHandle.state} changes, and once with the initial state. */
  readonly onState?: (state: SyncState) => void
  /** Called when documents arrive from the server, so a view can re-read. */
  readonly onIncoming?: () => void
}

/**
 * What the remote has to be able to answer.
 *
 * Only `info()`, and it is load-bearing — see {@link replicateProject}. PouchDB's `paused` event
 * carries **no argument** whether the replication caught up or cannot reach the server at all;
 * verified against `pouchdb-browser` in a browser, where a sync against `http://127.0.0.1:1`
 * emits exactly `paused(undefined)` twice and never an `error`. So "are we actually connected"
 * has to be asked rather than inferred.
 */
export interface Reachable {
  info(): Promise<unknown>
}

/** The subset of PouchDB used here, so this module needs no PouchDB import of its own. */
export interface Syncable {
  sync(
    remote: unknown,
    options: { live: boolean; retry: boolean },
  ): {
    on(event: 'change', handler: (info: { direction: string }) => void): unknown
    on(event: 'paused', handler: (error?: unknown) => void): unknown
    on(event: 'active', handler: () => void): unknown
    on(event: 'error', handler: (error: unknown) => void): unknown
    cancel(): void
  }
}

/**
 * Starts replicating, in both directions, and keeps doing it.
 *
 * `live` and `retry` together are the whole of the second and third scenarios:
 *
 * - **`live`** means changes propagate as they happen rather than when something asks. The
 *   scenario says "without any action from me", and a sync that had to be triggered would put
 *   the action back.
 * - **`retry`** means a dropped connection is a pause rather than the end. Without it the sync
 *   emits an error and stops, and the application is then silently not syncing — which looks
 *   exactly like being caught up.
 */
export function replicateProject(
  local: Syncable,
  remote: Reachable,
  options: SyncOptions = {},
): SyncHandle {
  let state: SyncState = 'active'
  let cancelled = false
  let probing = false

  const report = (next: SyncState): void => {
    // A stopped sync stays stopped. PouchDB emits a `paused` after `cancel()`, and letting that
    // through would leave the interface saying "waiting for a connection" about a replication
    // nobody is running.
    if (cancelled || state === next) return
    state = next
    options.onState?.(next)
  }

  const sync = local.sync(remote, { live: true, retry: true })

  sync.on('change', (info) => {
    report('active')
    // Only the inbound direction. A view re-reading because *this* browser wrote something
    // would be re-reading in response to its own write, which it already knows about.
    if (info.direction === 'pull') options.onIncoming?.()
  })

  sync.on('active', () => report('active'))

  /**
   * Works out which kind of pause this is, by asking the server.
   *
   * **`paused` cannot be read on its own.** PouchDB emits it with no argument both when the
   * replication has caught up and when it cannot reach the server at all — verified, not
   * assumed: against `http://127.0.0.1:1` the events are exactly `paused(undefined)` twice and
   * nothing else. Mapping that to "idle" would leave the interface reporting *caught up* about a
   * replication that has never once reached the server, which is precisely the failure worth
   * showing, and the one a user cannot otherwise detect.
   *
   * So the question is asked directly. It costs one request per pause, and a pause is what
   * happens when things settle rather than something that happens per document.
   */
  const classifyPause = async (): Promise<void> => {
    // No `cancelled` check here. `report` has one, and it is the only place state changes — a
    // second check would mean neither is load-bearing and neither could be tested. This one
    // matters because the probe is *in flight* across a cancel: the request was sent while the
    // sync was running and resolves after it stopped.
    if (probing) return
    probing = true
    try {
      await remote.info()
      report('idle')
    } catch {
      report('offline')
    } finally {
      probing = false
    }
  }

  sync.on('paused', (error) => {
    // An error here is unambiguous, so it needs no round trip. `undefined` is the ambiguous
    // case, and the only one worth paying for.
    if (error !== undefined) report('offline')
    else void classifyPause()
  })

  // With `retry` on, PouchDB does not emit `error` for a network failure — it pauses. Anything
  // that reaches here is something retrying will not fix.
  sync.on('error', () => report('offline'))

  options.onState?.(state)

  return {
    cancel(): void {
      if (cancelled) return
      cancelled = true
      sync.cancel()
      state = 'stopped'
      options.onState?.('stopped')
    },
    state: () => state,
  }
}
