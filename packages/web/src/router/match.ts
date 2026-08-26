/**
 * Hash-route matching, as a pure function over strings.
 *
 * Pure and browser-free on purpose: an off-by-one in path segmentation produces a
 * plausible wrong view rather than an error, which is exactly the class of bug that needs
 * exhaustive, fast tests rather than a rendered page to find.
 *
 * @module
 */

/** One entry in the route registry. An entry with a `label` also appears in the navigation. */
export interface Route {
  /** Leading-slash path, with `:name` marking a parameter segment. */
  readonly path: string
  /** Key into the shell's view map. */
  readonly view: string
  /** Navigation label. A function so it re-evaluates when the locale changes. */
  readonly label?: () => string
  /** Web Awesome icon name for the navigation entry. */
  readonly icon?: string
}

/** A route and the parameters captured from the path. */
export interface RouteMatch {
  readonly route: Route
  readonly params: Readonly<Record<string, string>>
}

/**
 * Splits a path into segments for route matching.
 *
 * Deliberately does not special-case a leading slash or an all-empty path: every route
 * path and every normalised location path shares the same leading `/` (or is empty), so
 * splitting both the same way and comparing element-by-element cancels the shared leading
 * empty segment out on its own - it lands at the same index on both sides and an empty
 * string matches an empty string, exactly as any other identical segment would.
 *
 * What must be handled explicitly is the *trailing* slash, because only the incoming
 * location ever carries one; a route path never does. Without stripping it,
 * `/devices/abc/` would gain a trailing empty segment that no route could ever have,
 * and a followable link would stop matching for no reason visible at the call site.
 *
 * Internal empty segments (from `//`) are intentionally kept rather than filtered: they
 * shift every later segment's index by one, which is what makes `/devices//remarks` fail
 * to line up with `/devices/:id/remarks` instead of quietly collapsing onto the shorter
 * `/devices/:id`. See the empty-value guard in {@link matchRoute}.
 */
function segments(path: string): string[] {
  const trimmed = path.endsWith('/') ? path.slice(0, -1) : path
  return trimmed.split('/')
}

/**
 * Finds the first route matching a location hash.
 *
 * Accepts `''`, `'#'`, `'#/'` and `'/'` as the root, because that is the range of values a
 * browser reports for "no hash" depending on how the page was reached.
 *
 * @returns The match, or `null` when nothing matched. `null` rather than a not-found route,
 *   because "nothing matched" and "the user asked for the not-found page" are different facts.
 */
export function matchRoute(hash: string, routes: readonly Route[]): RouteMatch | null {
  const withoutQuery = hash.split('?')[0] ?? ''
  // Only the `#` is stripped here - deliberately no leading-slash strip. A hash that is
  // empty or `#`/`#/`/`/` still normalises to the root via `segments`' own handling below,
  // but a non-root hash that doesn't begin with `/` after the `#` (e.g. `#devices/abc`, or
  // `devices/abc` with no `#` at all) is not a route in this scheme and must fall through
  // to `null`. Do not "fix" that by re-adding a leading-slash strip: it would make such a
  // hash silently resolve to a real view instead of not-found. See
  // packages/web/test/router/match.test.ts for the tests that pin this.
  const path = withoutQuery.startsWith('#') ? withoutQuery.slice(1) : withoutQuery
  const actual = segments(path)

  for (const route of routes) {
    const expected = segments(route.path)
    if (expected.length !== actual.length) continue

    const params: Record<string, string> = {}
    let matched = true

    for (const [index, part] of expected.entries()) {
      const value = actual[index] as string
      if (part.startsWith(':')) {
        // An empty segment (from a doubled `/`) is never a valid parameter value: without
        // this guard `/devices//remarks` would bind `id` to `''` against `/devices/:id`
        // instead of failing to match, because the length check alone cannot tell an
        // empty capture from a real one.
        if (value === '') {
          matched = false
          break
        }
        // A malformed percent-escape (e.g. `%E0` with no valid UTF-8 continuation) makes
        // `decodeURIComponent` throw `URIError`. That is a fact about the input, not a
        // reason to abort matching: the safe direction for unparseable input is "no match",
        // the same rule this project already applies to entitlement gates - a route that
        // throws takes rendering down instead of falling through to not-found. Do not
        // "helpfully" rethrow this; treat the candidate route as unmatched and let the loop
        // try the next one.
        try {
          params[part.slice(1)] = decodeURIComponent(value)
        } catch {
          matched = false
          break
        }
      } else if (part !== value) {
        matched = false
        break
      }
    }

    if (matched) return { route, params }
  }

  return null
}
