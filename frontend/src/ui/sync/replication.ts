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
 * A refusal (`denied`) is the one thing the live sync cannot be trusted to report twice: see
 * {@link SyncState} and {@link pushOnce}.
 *
 * Lives in `src/ui` rather than `src/data` for the reason `db/project-database.ts`
 * gives: this is *wiring*, and `src/data` deliberately imports no PouchDB implementation.
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
  /**
   * The server refused documents this browser sent: a CouchDB validator said no, as it does for
   * an archived project or an owner whose plan has lapsed.
   *
   * **Sticky, and not an error the sync dies of.** PouchDB reports a refusal per document and
   * carries on, so the sync goes on to say `paused` and the probe says the server is reachable.
   * Letting that overwrite this state would show "caught up" about a project whose edits are
   * not arriving. Only a push that gets through again (or stopping) clears it.
   *
   * **In memory only, and not retried.** The state is lost on reload or stop-then-start, and the
   * live sync does *not* resend a refused document - its checkpoint has moved past it. The
   * reliable check for "did everything arrive" is {@link pushOnce}, which ignores checkpoints.
   */
  | 'denied'

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
    on(event: 'change', handler: (info: SyncChange) => void): unknown
    on(event: 'denied', handler: (reason: unknown) => void): unknown
    on(event: 'paused', handler: (error?: unknown) => void): unknown
    on(event: 'active', handler: () => void): unknown
    on(event: 'error', handler: (error: unknown) => void): unknown
    cancel(): void
  }
  /** One-shot replication, for {@link pushOnce}. */
  replicate: {
    to(
      remote: unknown,
      options: { live: false; retry: false; checkpoint: false },
    ): {
      on(
        event: 'complete',
        handler: (info: { docs_written: number; doc_write_failures?: number }) => void,
      ): unknown
      on(event: 'denied', handler: (reason: unknown) => void): unknown
      on(event: 'error', handler: (error: unknown) => void): unknown
      cancel(): void
    }
  }
}

/** What a sync `change` event says, narrowed to what this module reads. */
export interface SyncChange {
  readonly direction: string
  readonly change?: { readonly docs_written?: number }
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
  let pushWritten = 0

  const report = (next: SyncState, clearDenied = false): void => {
    // A stopped sync stays stopped. PouchDB emits a `paused` after `cancel()`, and letting that
    // through would leave the interface saying "waiting for a connection" about a replication
    // nobody is running.
    if (cancelled || state === next) return
    // `denied` yields only to `stopped` (set in `cancel`) and to a successful push below.
    if (state === 'denied' && !clearDenied) return
    state = next
    options.onState?.(next)
  }

  const sync = local.sync(remote, { live: true, retry: true })

  sync.on('denied', () => report('denied', true))

  sync.on('change', (info) => {
    // A push that lands something new is the proof the server accepts us again. Only
    // `docs_written` is read: PouchDB's counters are cumulative over the whole replication and
    // `errors` keeps a refused document for as long as the sync lives, so "no errors" would
    // never come true. A refusal arrives as `denied` *before* the `change` of its own batch and
    // a denial-only batch emits no `change` at all, so the two cannot be told apart from a batch
    // that was partly refused; validators here refuse a whole project at once (archived, lapsed
    // plan), so that case is accepted as unreachable rather than modelled.
    let pushed = false
    if (info.direction === 'push') {
      const written = info.change?.docs_written ?? 0
      pushed = written > pushWritten
      pushWritten = written
    }
    report('active', pushed)
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

/**
 * Sends everything pending to the server once, and says whether it all arrived.
 *
 * **Why a second mechanism beside the live sync.** "Nothing is pending" is a claim the live
 * sync cannot make: it is always, by design, about to do something. Removing the local copy of a
 * synchronized project is only safe after that claim, so this runs a non-live, non-retrying
 * push that completes exactly when every local document has been offered to the server. It runs
 * alongside the live sync without touching its checkpoint.
 *
 * **`checkpoint: false` is what makes "nothing pending" true.** `live` and `retry` do not enter
 * PouchDB's replication id, so without it this push shares the live sync's checkpoint - and
 * PouchDB advances that checkpoint after every batch *even when documents were denied*. A
 * document the live sync was refused would then never be offered again: the push would find
 * nothing new and resolve, and the caller would delete the only copy. Without a checkpoint the
 * whole database is diffed against the server each time, so a refused document is refused (and
 * reported) again on every call.
 *
 * Rejects on any failure, **including a refused document** or any counted write failure: PouchDB completes a push that was
 * partly denied, and treating that as success would let the caller delete data the server never
 * accepted. `retry: false` makes an unreachable server an error here rather than a wait.
 */
export function pushOnce(
  local: Syncable,
  remote: unknown,
  options: { signal?: AbortSignal } = {},
): Promise<{ pushed: number }> {
  return new Promise((resolve, reject) => {
    const push = local.replicate.to(remote, { live: false, retry: false, checkpoint: false })
    let denied: unknown
    const onAbort = (): void => {
      push.cancel()
      reject(new Error('The push was cancelled'))
    }
    options.signal?.addEventListener('abort', onAbort, { once: true })
    const done = (): void => options.signal?.removeEventListener('abort', onAbort)
    if (options.signal?.aborted) return onAbort()

    push.on('denied', (reason) => {
      denied = reason
    })
    push.on('complete', (info) => {
      done()
      if (denied !== undefined)
        reject(new Error('The server refused some changes', { cause: denied }))
      // Counted on `complete` whether or not a `denied` was emitted for each: any failure means
      // something is still only here.
      else if ((info.doc_write_failures ?? 0) > 0)
        reject(new Error(`${info.doc_write_failures} changes could not be written to the server`))
      else resolve({ pushed: info.docs_written })
    })
    push.on('error', (error) => {
      done()
      reject(error instanceof Error ? error : new Error('The push failed', { cause: error }))
    })
  })
}
