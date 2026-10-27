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
 * A stand-in for the shell's `escrow` seam (#301), doing nothing.
 *
 * Injected wherever a test signs the shell in, so the signed-in transition neither generates a
 * device key nor asks the test server for an escrow key — a test must depend on neither.
 */
export const noEscrow = async (): Promise<void> => {}

/**
 * A refresher factory that reports `signed-out` on its first start and `refreshed` on every
 * later one — the shape of an email sign-in: the device had no session when the shell started,
 * and a restart after the verify finds the stored refresh token valid. `starts` counts the
 * factory's invocations, so a test can assert the restart actually happened.
 */
export function refresherSignedOutThenRefreshed() {
  const counters = { starts: 0, stops: 0 }
  const factory = (onOutcome: (o: TokenOutcome) => void): StubRefresher => {
    counters.starts += 1
    const outcome: TokenOutcome =
      counters.starts === 1 ? { kind: 'signed-out' } : { kind: 'refreshed', expiresIn: 300 }
    queueMicrotask(() => onOutcome(outcome))
    return {
      stop() {
        counters.stops += 1
      },
    }
  }
  return { factory, counters }
}

/**
 * A refresher factory that answers `unreachable` and nothing else: the app opened with no
 * connection. `tokenStored` is what the real exchange says about this device's store — `true`
 * is the #215 case, a stored session whose holder is still owed Sign out.
 */
export function refresherUnreachable(tokenStored = false) {
  return (onOutcome: (o: TokenOutcome) => void): StubRefresher => {
    queueMicrotask(() => onOutcome({ kind: 'unreachable', tokenStored }))
    return { stop() {} }
  }
}
