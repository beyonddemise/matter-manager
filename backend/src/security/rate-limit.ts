/**
 * Rate limiting, in memory, for this process only.
 *
 * **A fixed window per client**, not a token bucket and not a sliding log: the endpoints being
 * limited are sign-in ones, where the question is "has this address tried too many times
 * lately", and a fixed window answers it in one integer per client. A sliding log answers it
 * more precisely at the cost of remembering every request, which is the thing an attacker gets
 * to choose the size of.
 *
 * **It is per process.** Two instances behind a load balancer enforce the limit twice over, once
 * each — see ADR 0016, which is where that constraint on deployment is recorded rather than left
 * to be discovered. The alternative is a shared store, which is a database this service does not
 * otherwise need.
 *
 * No dependency: `@fastify/rate-limit` is a good library, and this is a `Map`, an integer and a
 * subtraction (ADR 0013).
 *
 * @module
 */

/** How much traffic one client may send. */
export interface Limit {
  /** Requests allowed per window. */
  readonly max: number
  /** How long the window lasts, in seconds. */
  readonly windowSeconds: number
  /**
   * How many distinct clients to account for at once.
   *
   * Reached only under a flood from many addresses. See {@link rateLimiter} for why a full
   * limiter refuses newcomers rather than evicting somebody to make room.
   */
  readonly maxClients?: number
}

/** What the limiter decided, and what to tell the client. */
export interface Decision {
  readonly allowed: boolean
  /** Requests left in this window. Never negative — it is a number the client reads. */
  readonly remaining: number
  /** Seconds until the window resets. Never zero: `Retry-After: 0` invites an instant retry. */
  readonly retryAfterSeconds: number
}

/** Counting requests per client. */
export interface RateLimiter {
  /** Counts one request from `key` and decides. */
  check(key: string): Decision
  /** How many clients are currently accounted for. For the tests and for a log line. */
  size(): number
}

/** The default ceiling on distinct clients: large enough to be reached only under attack. */
const DEFAULT_MAX_CLIENTS = 10_000

/** The system clock, in whole seconds. */
const systemClock = (): number => Date.now() / 1000

/**
 * Builds a limiter.
 *
 * When the map is full, a **new** client is refused rather than admitted by evicting an
 * existing one. Eviction would be a bypass anybody could trigger on purpose: make enough noise
 * from enough addresses and the entry counting your own attempts is dropped. Refusing is the
 * conservative answer for sign-in endpoints — a service with no room left to account for a
 * client has no business minting tokens for it — and clients already counted are unaffected.
 *
 * @param now the clock in seconds, injected so tests do not wait a minute to see a window pass
 */
export function rateLimiter(limit: Limit, now: () => number = systemClock): RateLimiter {
  const maxClients = limit.maxClients ?? DEFAULT_MAX_CLIENTS

  /** Per client: when its window started, and how many requests it has made inside it. */
  const clients = new Map<string, { windowStartedAt: number; used: number }>()

  /** When the map was last cleared of expired entries. */
  let lastSweptAt = Number.NEGATIVE_INFINITY

  /** Drops every client whose window has passed. Cheap: these entries are two numbers. */
  const sweep = (at: number): void => {
    lastSweptAt = at
    for (const [key, entry] of clients) {
      if (at - entry.windowStartedAt >= limit.windowSeconds) clients.delete(key)
    }
  }

  const refusal = (secondsLeft: number): Decision => ({
    allowed: false,
    remaining: 0,
    // Rounded up, and never zero: a client told to wait no time at all retries immediately and
    // is refused again, which costs more than the request that was refused.
    retryAfterSeconds: Math.max(1, Math.ceil(secondsLeft)),
  })

  return {
    check(key: string): Decision {
      const at = now()

      // At most once per window, so the cost is amortised to nothing and an entry outlives its
      // window by at most one more. Without it the map keeps every address that has ever asked
      // — bounded by `maxClients`, but that is a ceiling, not housekeeping, and it would be
      // reached by ordinary traffic over time rather than only under attack.
      if (at - lastSweptAt >= limit.windowSeconds) sweep(at)

      const existing = clients.get(key)

      // A window that has passed is not a client we know: start it again from nothing. Note
      // that this happens on *every* check, so an entry cannot outlive its window even if the
      // sweep below never runs.
      const entry =
        existing !== undefined && at - existing.windowStartedAt < limit.windowSeconds
          ? existing
          : undefined

      if (entry === undefined) {
        if (clients.size >= maxClients) {
          sweep(at)
          if (clients.size >= maxClients) return refusal(limit.windowSeconds)
        }
        clients.set(key, { windowStartedAt: at, used: 1 })
        return { allowed: true, remaining: limit.max - 1, retryAfterSeconds: limit.windowSeconds }
      }

      const secondsLeft = entry.windowStartedAt + limit.windowSeconds - at

      // Counted before the verdict, but the window start is **not** moved. A limiter that
      // restarts its window on a refused request lets a client that keeps hammering lock itself
      // out indefinitely, and rewards the one that gave up politely by letting it back first.
      // The window belongs to the traffic that was allowed.
      if (entry.used >= limit.max) return refusal(secondsLeft)

      entry.used += 1
      return {
        allowed: true,
        // Cannot be negative: this branch is only reached when `used` was below `max` before
        // the increment. Clamping here would be a guard against a state the line above rules
        // out, and a guard that can never fire is a guard nobody can test.
        remaining: limit.max - entry.used,
        retryAfterSeconds: Math.max(1, Math.ceil(secondsLeft)),
      }
    },

    size(): number {
      return clients.size
    },
  }
}
