/**
 * Reading the security configuration out of the environment.
 *
 * Separate from the policies themselves so that `process.env` is touched in one place and the
 * rules are testable without it. Nothing here validates an origin — {@link corsPolicy} does
 * that, at startup, once, so there is one answer to "is this a usable origin" rather than two
 * that can drift apart.
 *
 * @module
 */

/** Splits a comma-separated list, dropping the empties a trailing comma leaves behind. */
const listOf = (value: string | undefined): string[] =>
  (value ?? '')
    .split(',')
    .map((entry) => entry.trim())
    .filter((entry) => entry !== '')

/**
 * The origins allowed to make cross-origin requests.
 *
 * `APP_ORIGIN` is where the OAuth flow already sends the user back to, so a deployment that can
 * sign anybody in has stated it — and having it imply cross-origin access removes one variable
 * that could be set correctly while the other is forgotten. `CORS_ORIGINS` is for the
 * deployments where that is not the whole answer: a staging front end, a second domain.
 *
 * Returns an empty list when neither is set, which allows nothing. A deployment that forgot
 * should refuse the application rather than admit the internet.
 */
export function originsFromEnv(env: Record<string, string | undefined>): string[] {
  return [...new Set([...listOf(env.CORS_ORIGINS), ...listOf(env.APP_ORIGIN)])]
}
