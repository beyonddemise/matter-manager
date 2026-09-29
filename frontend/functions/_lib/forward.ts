/**
 * Everything the two Pages Functions do, with the side effects pushed to one function at the
 * bottom (Task 5) so the rest can be tested by calling it.
 *
 * The production half of the contract `frontend/vite.config.ts` states: `/api` and `/db` are
 * served from the application's own origin with the prefix stripped. Vite keeps that promise
 * in development. Until this file existed nothing kept it in production, and the way it failed
 * is the reason for the care below — a missing proxy does not 404. Both paths fell through to
 * the single-page application's fallback and answered 200 with the app shell.
 */

/** The two things this site forwards to. */
export type Upstream = 'api' | 'db'

/** The path prefix each one is mounted at. Same strings as the keys of `devProxy`. */
export type Prefix = '/api' | '/db'

/**
 * The Pages project's environment, as much of it as this module reads.
 *
 * Optional and `string | undefined` rather than `string`, because that is what a Function
 * actually receives: an unset variable is simply not there.
 */
export interface ForwardEnv {
  API_ORIGIN?: string | undefined
  COUCHDB_URL?: string | undefined
}

/** Where a prefix points, and the name of the variable that aimed it. */
export interface Target {
  /** The upstream origin, or `''` when nothing usable was configured. */
  origin: string
  /** The environment variable this came from, so a failure can name it. */
  variable: string
}

/**
 * Where each prefix points, given an environment.
 *
 * Takes `env` as an argument for the reason `devProxy` does: so a test can supply one. It is
 * also how the Function gets it — Pages passes the project's variables as `context.env`, not
 * as `process.env`, and there is no `process` in the Workers runtime to read.
 *
 * An empty or whitespace-only value is treated as absent. A dashboard field saved blank, or a
 * deployment tool rendering an unset variable, produces `''` rather than nothing at all, and
 * the difference is invisible at the point it matters.
 */
export function targets(env: ForwardEnv): Record<Prefix, Target> {
  return {
    '/api': { origin: (env.API_ORIGIN ?? '').trim(), variable: 'API_ORIGIN' },
    '/db': { origin: (env.COUCHDB_URL ?? '').trim(), variable: 'COUCHDB_URL' },
  }
}

/** The prefix an upstream is mounted at. */
export function prefixFor(kind: Upstream): Prefix {
  return kind === 'api' ? '/api' : '/db'
}

/**
 * Removes the mount point from a path.
 *
 * Returns `''` for the bare prefix rather than `/`, which looks like an omission and is not:
 * `devProxy`'s rewrite is `path.replace(/^\/api/, '')` and produces exactly that, and the
 * parity test in `forward.test.ts` compares the two functions character for character across
 * a list of paths. Normalising here and not there would be a genuine divergence between
 * development and production, reported by a passing test. `upstreamUrl` normalises instead.
 */
export function stripPrefix(pathname: string, prefix: Prefix): string {
  return pathname.startsWith(prefix) ? pathname.slice(prefix.length) : pathname
}
