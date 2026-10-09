import type { TokenOutcome } from '../../src/ui/composition.js'
import type { SessionState } from '../../src/ui/session.js'

/** What a refresher stub hands back, and what a test can check afterwards. */
export interface StubRefresher {
  stop(): void
}

/**
 * A stand-in for the shell's `refresher` seam that reports one outcome and never refreshes again.
 *
 * Takes the old three-state vocabulary because most shell tests care about what the interface
 * shows for a session, not about how the token got there.
 */
export function refresherReporting(session: SessionState) {
  const outcome: TokenOutcome =
    session === 'signed-in'
      ? { kind: 'refreshed', expiresIn: 300 }
      : session === 'expired'
        ? { kind: 'ended' }
        : { kind: 'signed-out' }
  return (onOutcome: (o: TokenOutcome) => void): StubRefresher => {
    queueMicrotask(() => onOutcome(outcome))
    return { stop() {} }
  }
}

/** A refresher that never answers, for the moment before the first answer. */
export const refresherNeverAnswering = (): StubRefresher => ({ stop() {} })

/**
 * A refresher that answers `unreachable` and nothing else: the app opened with no connection,
 * so the session stays unknown for the whole outage.
 */
export function refresherUnreachable(onOutcome: (o: TokenOutcome) => void): StubRefresher {
  queueMicrotask(() => onOutcome({ kind: 'unreachable' }))
  return { stop() {} }
}
