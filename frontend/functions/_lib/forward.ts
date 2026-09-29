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

/**
 * The address the request is actually sent to.
 *
 * String concatenation rather than `new URL(path, origin)`, and that is the careful choice
 * rather than the lazy one: `new URL` normalises, and normalising a path that a browser has
 * already percent-encoded re-encodes it. PouchDB document ids contain spaces and slashes as a
 * matter of course, so `a%20b` would go upstream as `a%2520b` and the document would not be
 * found - a failure that looks like missing data rather than like a broken proxy.
 *
 * Two shapes have to be handled and neither is hypothetical:
 *
 * - **A trailing slash on the origin.** `COUCHDB_URL` is set on the live project as
 *   `https://couch.matter-manager.io/`. Concatenated with `/project_local` that is `//project_local`,
 *   whose first path segment is empty, which is a different route.
 * - **An empty path**, which is what `stripPrefix` leaves for a bare `/db`. `origin + '' + '?x'`
 *   is a URL with no path at all.
 */
export function upstreamUrl(origin: string, pathname: string, search: string): string {
  return `${origin.replace(/\/+$/, '')}${pathname === '' ? '/' : pathname}${search}`
}

/**
 * Headers that describe one connection rather than the message travelling over it.
 *
 * RFC 9110's hop-by-hop set. They are removed in both directions: this Function terminates the
 * browser's connection and opens a new one, so every one of these is a statement about a
 * connection the other end is not on.
 */
export const HOP_BY_HOP: readonly string[] = [
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
]

/**
 * The headers to send upstream.
 *
 * Starts from what the browser sent and takes things away, rather than building an allowlist
 * from nothing. An allowlist would mean every future header the application starts sending -
 * `If-None-Match`, `Range`, a content type PouchDB picks - has to be remembered here, and
 * forgetting one produces a subtly wrong response rather than an error.
 *
 * `Host` is deleted rather than set. `fetch` derives it from the URL, which is exactly what
 * `changeOrigin: true` does in the development proxy; an inherited `Host: app.matter-manager.io`
 * would contradict it, and Caddy on the droplet routes on `Host`, so the request would arrive
 * at the wrong site block.
 */
export function upstreamHeaders(request: Request, kind: Upstream): Headers {
  const headers = new Headers(request.headers)

  for (const name of HOP_BY_HOP) headers.delete(name)
  headers.delete('host')

  // The session cookie is `Path=/`, so the browser attaches it to `/db/*` as readily as to
  // `/api/*`. CouchDB authenticates replication with the bearer JWT and has no use for it, so
  // forwarding would hand a thirty-day credential to a different service and write it into
  // that service's logs on every request - with nothing anywhere looking wrong.
  if (kind === 'db') headers.delete('cookie')

  // Overwritten, never appended. The API runs with TRUST_PROXY=true and Fastify reads the
  // leftmost entry as the client address, so anything the caller put there would be believed.
  // `CF-Connecting-IP` is set by the edge and cannot be forged from outside it. When it is
  // absent - which for a real request through Cloudflare it is not - the right answer is to
  // send nothing rather than to pass on an attacker-chosen value.
  const client = request.headers.get('cf-connecting-ip')
  if (client === null) headers.delete('x-forwarded-for')
  else headers.set('x-forwarded-for', client)

  // Always https: Cloudflare redirects http to https before a Function ever runs.
  headers.set('x-forwarded-proto', 'https')
  headers.set('x-forwarded-host', new URL(request.url).host)

  return headers
}

/**
 * The upstream's reply, rebuilt as ours.
 *
 * `new Response(upstream.body, upstream)` rather than copying headers into a plain object, and
 * the difference is one specific bug: a `Headers` built from an object keeps one value per
 * name, and `clearCookies` sets two `Set-Cookie` headers in a single reply. The user would be
 * told they had signed out while still holding one of the two cookies.
 *
 * Passing `upstream.body` is safe for a 204 or a 304 - statuses whose body the runtime refuses
 * to accept - because the body of such a response is already `null`. That is worth stating
 * rather than trusting: PouchDB revalidates constantly, so a mistake here would work in every
 * test and fail on the second replication.
 *
 * The body is a stream in both directions, so `_changes` and `_bulk_docs` are forwarded as
 * they arrive rather than buffered into the Function's memory.
 */
export function toResponse(upstream: Response): Response {
  const response = new Response(upstream.body, upstream)
  for (const name of HOP_BY_HOP) response.headers.delete(name)
  return response
}

/**
 * What a Pages Function is handed, narrowed to the two fields this module reads.
 *
 * Declared here rather than imported from `@cloudflare/workers-types`, deliberately. That
 * package redeclares `Request`, `Response` and `fetch`, and this `tsconfig.json` already has
 * `DOM` in `lib` and `node` in `types` - a third set of definitions for the same three names
 * is a larger problem than the six lines below.
 */
export interface PagesContext {
  request: Request
  env: ForwardEnv
}

/** A 502 that says which variable nobody set. */
function missingTarget(target: Target): Response {
  return new Response(
    `${target.variable} is not set on this Pages project, so this path has no upstream.\n`,
    {
      status: 502,
      headers: { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' },
    },
  )
}

/**
 * A 502 for an upstream that did not answer.
 *
 * Says nothing about which host was tried. The browser is the wrong audience for that: it
 * turns an internal hostname into something anybody can read, and the person who needs it has
 * the Function's logs.
 */
function unreachable(): Response {
  return new Response('The upstream did not answer.\n', {
    status: 502,
    headers: { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' },
  })
}

/**
 * Forwards one request to one upstream.
 *
 * The only function here with side effects, which is why everything above it is separate: the
 * rules are testable by calling them, and this is testable by passing `fetchImpl`.
 *
 * `redirect: 'manual'` is not a detail. The default is `follow`, and a Function that followed
 * would fetch `accounts.google.com` server-side during sign-in and return Google's HTML from
 * our own origin with a 200 - the user never redirected, no cookie set anywhere, and nothing
 * reported as an error.
 *
 * `fetchImpl` defaults to the global `fetch` and exists for the tests. A test that reached the
 * real network would be measuring Cloudflare's uptime.
 */
export async function forward(
  context: PagesContext,
  kind: Upstream,
  fetchImpl: typeof fetch = fetch,
): Promise<Response> {
  const prefix = prefixFor(kind)
  const target = targets(context.env)[prefix]

  // Before any fetch. A missing variable must fail where it is read, named - not become
  // `fetch('undefined/auth/google')`, whose error arrives somewhere else entirely and is about
  // a hostname nobody configured.
  if (target.origin === '') return missingTarget(target)

  const url = new URL(context.request.url)

  try {
    const upstream = await fetchImpl(
      upstreamUrl(target.origin, stripPrefix(url.pathname, prefix), url.search),
      {
        method: context.request.method,
        headers: upstreamHeaders(context.request, kind),
        body: context.request.body,
        redirect: 'manual',
      },
    )
    return toResponse(upstream)
  } catch {
    // Any throw here is a network-level failure. Left uncaught it becomes a Worker exception
    // and Cloudflare's own error page, which is HTML - and HTML from /api/* is precisely the
    // symptom this whole change exists to remove.
    return unreachable()
  }
}
