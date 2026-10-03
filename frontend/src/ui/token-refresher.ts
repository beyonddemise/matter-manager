/**
 * Keeps an access token fresh, and says when the session has really ended.
 *
 * Two failures, two answers, and confusing them is the bug this module exists to prevent:
 * - **unreachable** (offline, timeout, 5xx): retried silently with exponential backoff, and at
 *   once when the browser reports it is back online. This application works offline; a network
 *   blip must never sign anybody out.
 * - **ended** (a stored refresh token refused with 401): reported once, and nothing more is
 *   scheduled. The shell shows a notice and signs out *keeping* local data.
 *
 * @module
 */

import type { TokenOutcome } from './composition.js'
import { EXPIRY_MARGIN_SECONDS } from './tokens.js'

/** The first retry waits this long. */
export const BACKOFF_BASE_MS = 1000
/** No retry waits longer than this, however long the server has been away. */
export const BACKOFF_CAP_MS = 60_000

/**
 * Exponential from one second, capped at sixty, with up to half of it shaved off as jitter.
 *
 * Jitter, because every tab and device that lost the network at the same moment would otherwise
 * knock on the server at the same moment when it returns.
 *
 * @param attempt zero for the first retry
 * @param random a source in [0, 1), injectable so tests need no luck
 */
export function backoffDelay(attempt: number, random: () => number = Math.random): number {
  const ceiling = Math.min(BACKOFF_CAP_MS, BACKOFF_BASE_MS * 2 ** attempt)
  return Math.round(ceiling * (0.5 + random() / 2))
}

/**
 * No refresh is scheduled sooner than this after the last one, however short the token's life.
 * A server that issued 31-second tokens would otherwise be asked every second.
 */
export const MIN_REFRESH_DELAY_MS = 5000

/**
 * How long to wait before refreshing a token that lives `expiresIn` seconds.
 *
 * **Two margins early, not one.** `accessToken()` stops handing out a token at
 * `expiresIn - EXPIRY_MARGIN_SECONDS`; refreshing at exactly that moment leaves the request
 * itself (and any retry) running in a window where replication carries no `Authorization`
 * header at all. One extra margin of lead time covers a slow round trip.
 */
export function refreshDelay(expiresIn: number): number {
  return Math.max(MIN_REFRESH_DELAY_MS, (expiresIn - 2 * EXPIRY_MARGIN_SECONDS) * 1000)
}

/** Everything the refresher reaches for, so a test can run it without a clock or a network. */
export interface RefresherDependencies {
  /**
   * Asks for a token. Should not throw, but a throw is read as `unreachable`. The signal is
   * aborted by `stop()`, so a request in flight can refrain from storing what it fetched.
   */
  readonly request: (signal: AbortSignal) => Promise<TokenOutcome>
  /** Told every outcome, including each successful refresh. */
  readonly onOutcome: (outcome: TokenOutcome) => void
  /** Runs `run` after `ms`; returns a function that cancels it. */
  readonly schedule: (run: () => void, ms: number) => () => void
  /** Calls `run` whenever the browser regains a network; returns an unsubscribe. */
  readonly onOnline: (run: () => void) => () => void
  /**
   * Calls `run` when the page becomes visible again; returns an unsubscribe. Background tabs have
   * their timers throttled, so a refresh due while hidden can be late by minutes.
   */
  readonly onVisible?: (run: () => void) => () => void
  /** The clock in milliseconds, for deciding whether a refresh is overdue. */
  readonly now?: () => number
  readonly random?: () => number
}

/**
 * Starts refreshing immediately, then again shortly before each token expires.
 *
 * @returns a handle whose `stop` cancels the pending refresh and the online subscription, and
 *   silences a request already in flight
 */
export function startRefresher(deps: RefresherDependencies): { stop(): void } {
  let attempt = 0
  let cancel: (() => void) | undefined
  let stopped = false
  let dueAt = 0
  const now = deps.now ?? Date.now
  const controller = new AbortController()

  const arm = (ms: number): void => {
    dueAt = now() + ms
    cancel = deps.schedule(() => void run(), ms)
  }

  const run = async (): Promise<void> => {
    cancel = undefined
    let outcome: TokenOutcome
    try {
      outcome = await deps.request(controller.signal)
    } catch {
      // Why not let it propagate: `request` can fail *after* it has changed state (the access
      // token remembered, a changed refresh token not yet written), and a rejection here would
      // be unhandled and would also end the loop. Retrying is the right answer to an unknown.
      outcome = { kind: 'unreachable' }
    }
    if (stopped) return
    deps.onOutcome(outcome)
    switch (outcome.kind) {
      case 'refreshed':
        attempt = 0
        arm(refreshDelay(outcome.expiresIn))
        return
      case 'unreachable':
        arm(backoffDelay(attempt, deps.random))
        attempt += 1
        return
      case 'ended':
      case 'signed-out':
        return
    }
  }

  // Only retries while a retry is pending: a refresher that has ended stays ended, and one with
  // a request in flight does not start a second.
  const unsubscribe = deps.onOnline(() => {
    if (stopped || cancel === undefined) return
    cancel()
    attempt = 0
    void run()
  })

  // Retries only what is overdue: a visible tab whose timer is still running has nothing to
  // catch up on.
  const unsubscribeVisible = deps.onVisible?.(() => {
    if (stopped || cancel === undefined || now() < dueAt) return
    cancel()
    void run()
  })

  void run()
  return {
    stop() {
      stopped = true
      // Aborted so a request in flight does not store a token after sign-out has cleared them.
      controller.abort()
      unsubscribeVisible?.()
      cancel?.()
      unsubscribe()
    },
  }
}
