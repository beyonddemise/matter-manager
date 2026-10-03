/**
 * Access tokens refused after sign-out, until they would have expired anyway.
 *
 * **It protects this API only.** CouchDB verifies access tokens itself and never asks us, so a
 * token taken before sign-out still replicates until its `exp`. The five-minute TTL is what
 * bounds that, not this list. Per process and in memory, which matches one instance (#210).
 *
 * @module
 */

/** A set of refused token ids, each forgotten at its expiry. */
export interface DenyList {
  /** Refuses `jti` until `exp` (seconds since the epoch). */
  deny(jti: string, exp: number): void
  denied(jti: string): boolean
  /** Entries currently held. For tests and diagnostics. */
  size(): number
}

/** Creates an empty list on the given clock. */
export function denyList(now: () => number): DenyList {
  const entries = new Map<string, number>()
  const prune = (): void => {
    const t = now()
    for (const [jti, exp] of entries) if (exp <= t) entries.delete(jti)
  }
  return {
    deny(jti, exp) {
      prune()
      entries.set(jti, exp)
    },
    denied(jti) {
      const exp = entries.get(jti)
      return exp !== undefined && exp > now()
    },
    size: () => entries.size,
  }
}
