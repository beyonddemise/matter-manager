# Pages Functions proxy — implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Serve `/api/*` and `/db/*` from `app.matter-manager.io` itself via Cloudflare Pages Functions, so the browser never addresses a third-party origin and `connect-src 'self'` stays true.

**Architecture:** One pure module, `frontend/functions/_lib/forward.ts`, does all the reasoning — which origin a prefix points at, what the upstream URL is, which headers cross, how the reply is rebuilt. Two thin catch-all routes (`functions/api/[[path]].ts`, `functions/db/[[path]].ts`) bind it to Cloudflare's `onRequest`. `frontend/public/_routes.json` restricts Function invocation to those two prefixes so every static asset is still served by the CDN. The deploy runs from `frontend/` so wrangler finds `functions/` where it lives.

**Tech Stack:** TypeScript (NodeNext, `verbatimModuleSyntax`), Vitest (`ui-node` project, node environment), Biome 2.5.12, wrangler (new `frontend` devDependency), `cloudflare/wrangler-action` v4 pinned at `ebbaa15`.

**Spec:** `docs/superpowers/specs/2026-09-29-pages-functions-proxy-design.md`

## Global Constraints

- **Node >= 24.** Both `package.json` files declare it.
- **Every import specifier ends in `.js`.** `module: NodeNext` plus `verbatimModuleSyntax: true`; an extensionless relative import does not compile.
- **Biome formatting**: single quotes, no semicolons, trailing commas everywhere, 2-space indent, 100-column lines. Run `npm run check:fix` before committing; CI runs `npm run check`.
- **`type` imports must say so**: `verbatimModuleSyntax` requires `import type { X }` for types.
- **No new runtime dependency.** `@cloudflare/workers-types` is deliberately NOT added — it redeclares `Request`, `Response` and `fetch`, and this `tsconfig.json` already has `DOM` in `lib` and `node` in `types`. Three definitions of `Request` in one program is a worse problem than the small local `PagesContext` interface in Task 5.
- **Comment style**: this repository explains *why*, at length, and names the failure a line prevents. Match `check-deploy-headers.mjs` and `vite.config.ts`, not a generic house style.
- **Exact deployed values**: `API_ORIGIN=https://api.matter-manager.io`, `COUCHDB_URL=https://couch.matter-manager.io/` (trailing slash, verbatim).
- **All work on branch `claude/pages-functions-proxy`**, which already carries the spec.
- **Commit trailer**: every commit ends with `Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>`.

## Review Focus

Five things the spec implies but never asks a test for. Each one has a test assigned to the task that owns the code; they are listed here together because they share a cause — the spec enumerates the *auth* path carefully and the *replication* path hardly at all, and PouchDB is the caller that will meet all five first.

1. **`COUCHDB_URL` ends in `/`.** The live value is `https://couch.matter-manager.io/`. Naive concatenation gives `//project_local`, and an empty first path segment is a different route to CouchDB, not a cosmetic difference. → Task 2.
2. **The query string must survive.** Replication is `_changes?since=…&feed=longpoll&heartbeat=…`; a forwarder that rebuilds the URL from the pathname alone works for `/api/healthz` and silently breaks every replication request. The spec's test list never mentions it. → Task 2.
3. **Null-body statuses.** PouchDB leans on `304 Not Modified`, and Cloudflare's `Response` constructor *throws* if a 204/304 is given a body. A forwarder that always passes `upstream.body` must be proven safe for the status codes where the body is null. → Task 4.
4. **`HEAD` requests.** PouchDB checks document existence with `HEAD`, and a forwarder that hardcoded `GET` — or let the method fall to its default — would turn every existence check into a full document fetch that then fails to match. → Task 5.
5. **The bare prefix.** `/db` with nothing after it is CouchDB's root, and `/api` is the API's. Stripping leaves the empty string, which is not a valid path — it must become `/`. → Task 2.

---

### Task 1: Targets, prefix stripping, and parity with the dev proxy

The two functions that say *where a prefix points* and *what is left of the path*. They exist separately from everything else because they are the half that has a counterpart in `vite.config.ts`, and the parity test is the only thing that keeps the two from drifting.

**Files:**
- Create: `frontend/functions/_lib/forward.ts`
- Create: `frontend/test/ui/deploy/forward.test.ts`
- Modify: `frontend/tsconfig.json` (the `include` array, last line)

**Interfaces:**
- Consumes: `devProxy` from `frontend/vite.config.ts` (already exported).
- Produces:
  - `type Upstream = 'api' | 'db'`
  - `type Prefix = '/api' | '/db'`
  - `interface ForwardEnv { API_ORIGIN?: string; COUCHDB_URL?: string }`
  - `interface Target { origin: string; variable: string }`
  - `targets(env: ForwardEnv): Record<Prefix, Target>`
  - `prefixFor(kind: Upstream): Prefix`
  - `stripPrefix(pathname: string, prefix: Prefix): string`

- [ ] **Step 1: Let TypeScript see the new directory**

`frontend/tsconfig.json` ends with an `include` array that does not mention `functions`. Without this the whole directory is invisible to `npm run typecheck` — it would compile only at deploy time, inside wrangler, where a type error is a failed deployment rather than a failed check.

Replace the last line of `frontend/tsconfig.json`:

```json
  "include": ["src/**/*.ts", "test/**/*.ts", "functions/**/*.ts", "vite.config.ts"]
}
```

Biome and Vitest need no change: `frontend/biome.json` includes `**`, and the new test lands under `test/ui/`, which the `ui-node` project already globs.

- [ ] **Step 2: Write the failing test**

Create `frontend/test/ui/deploy/forward.test.ts`:

```ts
import { describe, expect, it } from 'vitest'
import { prefixFor, stripPrefix, targets } from '../../../functions/_lib/forward.js'
import { devProxy } from '../../../vite.config.js'

/**
 * The production forwarder, tested the way `dev-proxy.test.ts` tests its counterpart: by
 * handing the module an environment rather than letting it read one. The reason is the same
 * and is worth repeating — a test that reads the machine's own `.env` passes for its author
 * and fails for everybody else.
 */

describe('where each prefix points', () => {
  it('covers the same two prefixes the development proxy does', () => {
    expect(Object.keys(targets({})).sort()).toEqual(['/api', '/db'])
  })

  it('reads API_ORIGIN for /api and COUCHDB_URL for /db', () => {
    const env = { API_ORIGIN: 'https://api.example', COUCHDB_URL: 'https://db.example' }
    expect(targets(env)['/api'].origin).toBe('https://api.example')
    expect(targets(env)['/db'].origin).toBe('https://db.example')
  })

  it('names the variable that aims it, so a 502 can say which one is missing', () => {
    expect(targets({})['/api'].variable).toBe('API_ORIGIN')
    expect(targets({})['/db'].variable).toBe('COUCHDB_URL')
  })

  it('treats a variable that is present but empty as absent', () => {
    // A dashboard field saved blank, or a deployment tool rendering an unset value, produces
    // an empty string rather than an absent key. `composition.ts` and `devProxy` both make
    // this same equation; a forwarder that did not would fetch `/auth/google` with no origin.
    expect(targets({ API_ORIGIN: '' })['/api'].origin).toBe('')
    expect(targets({ API_ORIGIN: '   ' })['/api'].origin).toBe('')
  })

  it('maps each upstream to its prefix', () => {
    expect(prefixFor('api')).toBe('/api')
    expect(prefixFor('db')).toBe('/db')
  })
})

describe('stripping the prefix', () => {
  it('removes it, because the API serves its routes at the root', () => {
    expect(stripPrefix('/api/projects', '/api')).toBe('/projects')
    expect(stripPrefix('/db/project_local', '/db')).toBe('/project_local')
  })

  it('strips only the leading prefix', () => {
    // `/api/things/api-key` contains the word twice, and only the first is the mount point.
    expect(stripPrefix('/api/things/api-key', '/api')).toBe('/things/api-key')
  })

  it('leaves the empty string for the bare prefix, exactly as Vite does', () => {
    // Turning it into `/` is `upstreamUrl`'s job (Task 2), deliberately: this function has a
    // counterpart in vite.config.ts and the parity test below compares them character for
    // character. A normalisation applied here and not there would be a real divergence
    // reported as a passing test.
    expect(stripPrefix('/api', '/api')).toBe('')
    expect(stripPrefix('/db', '/db')).toBe('')
  })
})

describe('parity with the development proxy', () => {
  // Development and production are two implementations of one contract. Nothing but this
  // assertion stops them drifting, and a drift is invisible in both places: each works.
  it('agrees on which prefixes exist', () => {
    expect(Object.keys(targets({})).sort()).toEqual(Object.keys(devProxy({})).sort())
  })

  it('agrees on what stripping a prefix leaves', () => {
    const paths = ['/api', '/api/', '/api/projects', '/api/things/api-key', '/api/auth/google']
    for (const path of paths) {
      expect(stripPrefix(path, '/api')).toBe(devProxy({})['/api'].rewrite(path))
    }
    for (const path of ['/db', '/db/', '/db/project_local', '/db/_changes']) {
      expect(stripPrefix(path, '/db')).toBe(devProxy({})['/db'].rewrite(path))
    }
  })
})
```

- [ ] **Step 3: Run it and watch it fail**

```bash
cd frontend && npx vitest run test/ui/deploy/forward.test.ts
```

Expected: FAIL — `Failed to resolve import "../../../functions/_lib/forward.js"`.

- [ ] **Step 4: Write the module**

Create `frontend/functions/_lib/forward.ts`:

```ts
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
```

- [ ] **Step 5: Run the test and the typecheck**

```bash
cd frontend && npx vitest run test/ui/deploy/forward.test.ts && npm run typecheck
```

Expected: PASS, 10 tests. Typecheck clean — if it reports it cannot find `functions/_lib/forward.ts`, Step 1 was not applied.

- [ ] **Step 6: Format and commit**

```bash
cd frontend && npm run check:fix
cd .. && git add frontend/functions/_lib/forward.ts frontend/test/ui/deploy/forward.test.ts frontend/tsconfig.json
git commit -m "$(cat <<'EOF'
feat(functions): where /api and /db point, and a test that they still agree with Vite

The production half of the contract vite.config.ts has stated since M5. `targets` mirrors
`devProxy` on purpose - same shape, same argument, same treatment of a variable that is present
but empty - so that the parity test can import both and compare them rather than comparing each
against a copy of the rule.

`stripPrefix` returns '' for the bare prefix rather than '/', matching Vite's rewrite exactly.
Normalising is upstreamUrl's job. Done here it would be a real difference between development
and production that the parity test would report as agreement.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 2: Building the upstream URL

Assembling an origin, a stripped path and a query string into the address actually fetched. Small, and the home of three of the five Review Focus items.

**Files:**
- Modify: `frontend/functions/_lib/forward.ts` (append)
- Modify: `frontend/test/ui/deploy/forward.test.ts` (append)

**Interfaces:**
- Consumes: nothing from Task 1 at runtime; shares the file.
- Produces: `upstreamUrl(origin: string, pathname: string, search: string): string`

- [ ] **Step 1: Write the failing test**

Append to `frontend/test/ui/deploy/forward.test.ts`:

```ts
describe('the URL actually fetched', () => {
  it('joins the origin, the stripped path and the query', () => {
    expect(upstreamUrl('https://api.example', '/projects', '?limit=10')).toBe(
      'https://api.example/projects?limit=10',
    )
  })

  it('trims a trailing slash from the origin', () => {
    // COUCHDB_URL is set on the live project *with* a trailing slash. Concatenating gives
    // `https://couch.matter-manager.io//project_local`, and an empty first path segment is a
    // different route to CouchDB, not a cosmetic difference. The literal below is the deployed
    // value, not a tidied one, because a tidied one would leave this untested.
    expect(upstreamUrl('https://couch.matter-manager.io/', '/project_local', '')).toBe(
      'https://couch.matter-manager.io/project_local',
    )
  })

  it('trims however many slashes there are', () => {
    expect(upstreamUrl('https://db.example///', '/x', '')).toBe('https://db.example/x')
  })

  it('turns the bare prefix into the root', () => {
    // `stripPrefix('/db', '/db')` is '', and `https://db.example?x` is not the root with a
    // query - it is a URL whose path is empty, which CouchDB and the API both read differently
    // from `/`.
    expect(upstreamUrl('https://db.example', '', '')).toBe('https://db.example/')
    expect(upstreamUrl('https://db.example', '', '?a=1')).toBe('https://db.example/?a=1')
  })

  it('keeps the query string', () => {
    // Replication is `_changes?since=…&feed=longpoll&heartbeat=…`. A forwarder that rebuilt
    // the URL from the pathname alone would serve /api/healthz perfectly and break every
    // replication request, which is the sort of bug that gets diagnosed as "CouchDB is slow".
    expect(upstreamUrl('https://db.example', '/project_local/_changes', '?feed=longpoll&since=42')).toBe(
      'https://db.example/project_local/_changes?feed=longpoll&since=42',
    )
  })

  it('does not re-encode what the browser already encoded', () => {
    // The pathname arrives percent-encoded from `new URL(request.url).pathname`. Running it
    // through URL construction again would double-encode a document id containing a space or
    // a slash, and PouchDB document ids routinely contain both.
    expect(upstreamUrl('https://db.example', '/project_local/a%20b%2Fc', '')).toBe(
      'https://db.example/project_local/a%20b%2Fc',
    )
  })
})
```

Replace the import of the forwarder at the top of the file with:

```ts
import { prefixFor, stripPrefix, targets, upstreamUrl } from '../../../functions/_lib/forward.js'
```

- [ ] **Step 2: Run it and watch it fail**

```bash
cd frontend && npx vitest run test/ui/deploy/forward.test.ts
```

Expected: FAIL — `upstreamUrl is not a function`.

- [ ] **Step 3: Write the implementation**

Append to `frontend/functions/_lib/forward.ts`:

```ts
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
```

- [ ] **Step 4: Run the tests**

```bash
cd frontend && npx vitest run test/ui/deploy/forward.test.ts && npm run typecheck
```

Expected: PASS, 16 tests.

- [ ] **Step 5: Format and commit**

```bash
cd frontend && npm run check:fix
cd .. && git add frontend/functions/_lib/forward.ts frontend/test/ui/deploy/forward.test.ts
git commit -m "$(cat <<'EOF'
feat(functions): assemble the upstream URL without re-encoding it

Concatenation rather than `new URL(path, origin)`. `new URL` normalises, and normalising a
pathname the browser has already percent-encoded encodes it twice - `a%20b` goes upstream as
`a%2520b`. PouchDB document ids contain spaces and slashes routinely, so that failure would
present as missing documents rather than as a broken proxy.

Trailing slashes are trimmed from the origin because COUCHDB_URL is set on the live project
with one, and `//project_local` has an empty first path segment, which is a different route.
The test uses the deployed value rather than a tidied one; a tidied one would leave this
untested.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 3: The request headers that cross

Which headers reach the upstream, which are removed, and which are replaced. The `/db` cookie strip and the `X-Forwarded-For` overwrite both live here, and both are silent when wrong.

**Files:**
- Modify: `frontend/functions/_lib/forward.ts` (append)
- Modify: `frontend/test/ui/deploy/forward.test.ts` (append)

**Interfaces:**
- Consumes: `Upstream` from Task 1.
- Produces:
  - `const HOP_BY_HOP: readonly string[]`
  - `upstreamHeaders(request: Request, kind: Upstream): Headers`

- [ ] **Step 1: Write the failing test**

Append to `frontend/test/ui/deploy/forward.test.ts`:

```ts
/** A request as it arrives at the edge, with whatever headers the test needs. */
function incoming(url: string, headers: Record<string, string> = {}, method = 'GET'): Request {
  return new Request(url, { method, headers })
}

describe('the headers sent upstream', () => {
  it('forwards the session cookie to the API', () => {
    const headers = upstreamHeaders(
      incoming('https://app.matter-manager.io/api/projects', { cookie: 'mm_session=abc' }),
      'api',
    )
    expect(headers.get('cookie')).toBe('mm_session=abc')
  })

  it('strips the cookie on the way to CouchDB', () => {
    // The session cookie is Path=/, so the browser attaches it to every /db/* request without
    // being asked. CouchDB has no use for it - replication authenticates with the bearer JWT -
    // so forwarding it ships a thirty-day credential to a different service, and into its
    // logs, on every replication request. Nothing about that failure is visible: it works.
    const headers = upstreamHeaders(
      incoming('https://app.matter-manager.io/db/project_local', { cookie: 'mm_session=abc' }),
      'db',
    )
    expect(headers.get('cookie')).toBeNull()
  })

  it('forwards Authorization to both', () => {
    for (const kind of ['api', 'db'] as const) {
      const headers = upstreamHeaders(
        incoming('https://app.matter-manager.io/x', { authorization: 'Bearer token' }),
        kind,
      )
      expect(headers.get('authorization')).toBe('Bearer token')
    }
  })

  it('sets X-Forwarded-For from CF-Connecting-IP', () => {
    const headers = upstreamHeaders(
      incoming('https://app.matter-manager.io/api/x', { 'cf-connecting-ip': '203.0.113.9' }),
      'api',
    )
    expect(headers.get('x-forwarded-for')).toBe('203.0.113.9')
  })

  it('overwrites a caller-supplied X-Forwarded-For rather than appending to it', () => {
    // The API runs with TRUST_PROXY=true and Fastify reads the *leftmost* entry as the client
    // address. Appending would leave the caller's own value leftmost, letting them choose
    // their rate-limit bucket. compose.prod.yml states the consequence of getting this family
    // of settings wrong: "the first twenty sign-in attempts from anywhere lock out everybody
    // else."
    const headers = upstreamHeaders(
      incoming('https://app.matter-manager.io/api/x', {
        'x-forwarded-for': '10.0.0.1',
        'cf-connecting-ip': '203.0.113.9',
      }),
      'api',
    )
    expect(headers.get('x-forwarded-for')).toBe('203.0.113.9')
  })

  it('removes a caller-supplied X-Forwarded-For when the edge gave us no address', () => {
    // Keeping it would be worse than having none: it is attacker-chosen and would be trusted.
    const headers = upstreamHeaders(
      incoming('https://app.matter-manager.io/api/x', { 'x-forwarded-for': '10.0.0.1' }),
      'api',
    )
    expect(headers.get('x-forwarded-for')).toBeNull()
  })

  it('states the protocol and the host the browser used', () => {
    const headers = upstreamHeaders(incoming('https://app.matter-manager.io/api/x'), 'api')
    expect(headers.get('x-forwarded-proto')).toBe('https')
    expect(headers.get('x-forwarded-host')).toBe('app.matter-manager.io')
  })

  it('drops hop-by-hop headers', () => {
    // They describe this connection, not the message. Forwarding `Connection: keep-alive` or a
    // `Transfer-Encoding` to a different connection is a protocol error that some servers
    // tolerate and some do not.
    const headers = upstreamHeaders(
      incoming('https://app.matter-manager.io/api/x', {
        connection: 'keep-alive',
        'keep-alive': 'timeout=5',
        upgrade: 'websocket',
      }),
      'api',
    )
    for (const name of ['connection', 'keep-alive', 'upgrade']) {
      expect(headers.get(name)).toBeNull()
    }
  })

  it('does not carry the browser-facing Host upstream', () => {
    // fetch() derives Host from the URL it is given, which is what `changeOrigin: true` does
    // in the dev proxy. An explicit Host left over from the inbound request would contradict
    // it, and Caddy routes on Host - so the request would arrive at the wrong site block.
    const headers = upstreamHeaders(incoming('https://app.matter-manager.io/api/x'), 'api')
    expect(headers.get('host')).toBeNull()
  })

  it('adds no CORS headers', () => {
    // Every request through this Function is same-origin by construction. An
    // Access-Control-Allow-Origin here would describe a flow that does not exist and would be
    // the first thing to mislead somebody debugging a future one.
    const headers = upstreamHeaders(incoming('https://app.matter-manager.io/api/x'), 'api')
    expect(headers.get('access-control-allow-origin')).toBeNull()
  })
})
```

Replace the import of the forwarder at the top of the file with:

```ts
import {
  prefixFor,
  stripPrefix,
  targets,
  upstreamHeaders,
  upstreamUrl,
} from '../../../functions/_lib/forward.js'
```

- [ ] **Step 2: Run it and watch it fail**

```bash
cd frontend && npx vitest run test/ui/deploy/forward.test.ts
```

Expected: FAIL — `upstreamHeaders is not a function`.

- [ ] **Step 3: Write the implementation**

Append to `frontend/functions/_lib/forward.ts`:

```ts
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
```

- [ ] **Step 4: Run the tests**

```bash
cd frontend && npx vitest run test/ui/deploy/forward.test.ts && npm run typecheck
```

Expected: PASS, 26 tests.

- [ ] **Step 5: Format and commit**

```bash
cd frontend && npm run check:fix
cd .. && git add frontend/functions/_lib/forward.ts frontend/test/ui/deploy/forward.test.ts
git commit -m "$(cat <<'EOF'
feat(functions): the request headers that cross, and the two that must not

Subtractive rather than an allowlist: every future header the application starts sending would
otherwise have to be remembered here, and forgetting one produces a subtly wrong response
rather than an error.

Two removals carry the weight. Cookie is stripped on /db because the session cookie is Path=/ -
the browser attaches it to replication requests without being asked, CouchDB has no use for it,
and forwarding it would put a thirty-day credential into a second service's logs with nothing
looking wrong. X-Forwarded-For is overwritten from CF-Connecting-IP rather than appended to,
because Fastify with TRUST_PROXY reads the leftmost entry, so an appended value would let a
caller pick their own rate-limit bucket.

Host is deleted so fetch can derive it from the URL, which is what changeOrigin does in the dev
proxy. Caddy routes on Host; an inherited one would reach the wrong site block.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 4: Rebuilding the response

Turning the upstream reply into the one the browser gets. Short, and the home of the remaining two Review Focus items.

**Files:**
- Modify: `frontend/functions/_lib/forward.ts` (append)
- Modify: `frontend/test/ui/deploy/forward.test.ts` (append)

**Interfaces:**
- Consumes: `HOP_BY_HOP` from Task 3.
- Produces: `toResponse(upstream: Response): Response`

- [ ] **Step 1: Write the failing test**

Append to `frontend/test/ui/deploy/forward.test.ts`:

```ts
describe('the response handed back to the browser', () => {
  it('keeps the status and the status text', () => {
    const out = toResponse(new Response('no', { status: 403, statusText: 'Forbidden' }))
    expect(out.status).toBe(403)
    expect(out.statusText).toBe('Forbidden')
  })

  it('keeps a redirect as a redirect rather than following it', () => {
    // Step 3 of the sign-in flow. If this became a 200 the browser would be shown Google's
    // authorization page served from our origin, never navigated anywhere, and never given a
    // cookie - a failure that presents as a broken page, not as an error.
    const out = toResponse(
      new Response(null, { status: 302, headers: { location: 'https://accounts.google.com/o/oauth2/v2/auth?x=1' } }),
    )
    expect(out.status).toBe(302)
    expect(out.headers.get('location')).toBe('https://accounts.google.com/o/oauth2/v2/auth?x=1')
  })

  it('keeps both Set-Cookie headers when the upstream sets two', () => {
    // `clearCookies` sets two in one reply. Copying headers one key at a time through a plain
    // object keeps the last and loses the first, leaving a cookie the user believed they had
    // cleared - which is why this is `new Response(body, upstream)` and not a hand-copied map.
    const upstream = new Response(null, { status: 204 })
    upstream.headers.append('set-cookie', 'mm_session=; Max-Age=0; Path=/')
    upstream.headers.append('set-cookie', 'mm_flow=; Max-Age=0; Path=/')
    expect(toResponse(upstream).headers.getSetCookie()).toEqual([
      'mm_session=; Max-Age=0; Path=/',
      'mm_flow=; Max-Age=0; Path=/',
    ])
  })

  it('passes a 304 through without inventing a body', () => {
    // PouchDB leans on conditional requests, and the Response constructor *throws* if a
    // null-body status is given a body. A forwarder that always passed `upstream.body` would
    // work until the first cache revalidation and then 500.
    const out = toResponse(new Response(null, { status: 304, headers: { etag: '"1-abc"' } }))
    expect(out.status).toBe(304)
    expect(out.headers.get('etag')).toBe('"1-abc"')
  })

  it('passes a 204 through', () => {
    expect(toResponse(new Response(null, { status: 204 })).status).toBe(204)
  })

  it('drops hop-by-hop headers on the way back too', () => {
    const upstream = new Response('ok', { status: 200, headers: { connection: 'close' } })
    expect(toResponse(upstream).headers.get('connection')).toBeNull()
  })

  it('preserves the body', async () => {
    expect(await toResponse(new Response('{"ok":true}', { status: 200 })).text()).toBe('{"ok":true}')
  })
})
```

Replace the import of the forwarder at the top of the file with:

```ts
import {
  prefixFor,
  stripPrefix,
  targets,
  toResponse,
  upstreamHeaders,
  upstreamUrl,
} from '../../../functions/_lib/forward.js'
```

- [ ] **Step 2: Run it and watch it fail**

```bash
cd frontend && npx vitest run test/ui/deploy/forward.test.ts
```

Expected: FAIL — `toResponse is not a function`.

- [ ] **Step 3: Write the implementation**

Append to `frontend/functions/_lib/forward.ts`:

```ts
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
```

- [ ] **Step 4: Run the tests**

```bash
cd frontend && npx vitest run test/ui/deploy/forward.test.ts && npm run typecheck
```

Expected: PASS, 33 tests.

If `getSetCookie` is reported as not a function, the Node version is below 24 — check `node --version` against the `engines` field rather than working around it.

- [ ] **Step 5: Format and commit**

```bash
cd frontend && npm run check:fix
cd .. && git add frontend/functions/_lib/forward.ts frontend/test/ui/deploy/forward.test.ts
git commit -m "$(cat <<'EOF'
feat(functions): rebuild the reply so both Set-Cookie headers survive

`new Response(upstream.body, upstream)` rather than copying headers through an object. An
object keeps one value per name and clearCookies sets two Set-Cookie headers in one reply, so
the user would be told they had signed out while still holding one of the two cookies.

Tests cover 204 and 304 explicitly. The Response constructor throws if a null-body status is
given a body; passing upstream.body is safe only because it is already null for those, and
PouchDB revalidates often enough that a mistake would pass every test and fail on the second
replication.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 5: `forward()` and the two routes

The one function with side effects, the two 502s, and the files Cloudflare actually invokes.

**Files:**
- Modify: `frontend/functions/_lib/forward.ts` (append)
- Create: `frontend/functions/api/[[path]].ts`
- Create: `frontend/functions/db/[[path]].ts`
- Modify: `frontend/test/ui/deploy/forward.test.ts` (append)

**Interfaces:**
- Consumes: `targets`, `prefixFor`, `stripPrefix` (Task 1), `upstreamUrl` (Task 2), `upstreamHeaders` (Task 3), `toResponse` (Task 4).
- Produces:
  - `interface PagesContext { request: Request; env: ForwardEnv }`
  - `forward(context: PagesContext, kind: Upstream, fetchImpl?: typeof fetch): Promise<Response>`
  - `onRequest` in each route file.

- [ ] **Step 1: Write the failing test**

Append to `frontend/test/ui/deploy/forward.test.ts`:

```ts
/** Records what `forward` asked for, and answers with whatever the test supplies. */
function recordingFetch(reply: Response | (() => never)) {
  const calls: { url: string; init: RequestInit }[] = []
  const impl = (async (url: unknown, init: unknown) => {
    calls.push({ url: String(url), init: (init ?? {}) as RequestInit })
    if (typeof reply === 'function') reply()
    return reply
  }) as unknown as typeof fetch
  return { impl, calls }
}

const LIVE = {
  API_ORIGIN: 'https://api.matter-manager.io',
  COUCHDB_URL: 'https://couch.matter-manager.io/',
}

describe('forwarding a request', () => {
  it('sends /api/auth/google to the API with the prefix removed', async () => {
    const { impl, calls } = recordingFetch(new Response(null, { status: 302 }))
    await forward(
      { request: incoming('https://app.matter-manager.io/api/auth/google'), env: LIVE },
      'api',
      impl,
    )
    expect(calls[0]?.url).toBe('https://api.matter-manager.io/auth/google')
  })

  it('sends /db to CouchDB with the configured trailing slash collapsed', async () => {
    const { impl, calls } = recordingFetch(new Response('{}', { status: 200 }))
    await forward(
      { request: incoming('https://app.matter-manager.io/db/project_local'), env: LIVE },
      'db',
      impl,
    )
    expect(calls[0]?.url).toBe('https://couch.matter-manager.io/project_local')
  })

  it('never follows a redirect', async () => {
    // The default is `follow`. A Function that followed step 3 of the sign-in flow would fetch
    // Google's authorization page server-side and hand *that* back - a 200 of Google's HTML,
    // served from app.matter-manager.io, with the user never redirected and no cookie
    // anywhere. It fails as a broken page rather than as an error, which is why it is pinned.
    const { impl, calls } = recordingFetch(new Response(null, { status: 302 }))
    await forward(
      { request: incoming('https://app.matter-manager.io/api/auth/google'), env: LIVE },
      'api',
      impl,
    )
    expect(calls[0]?.init.redirect).toBe('manual')
  })

  it('answers 502 naming the variable when a target is not configured', async () => {
    const { impl, calls } = recordingFetch(new Response('unreachable'))
    const response = await forward(
      { request: incoming('https://app.matter-manager.io/api/healthz'), env: {} },
      'api',
      impl,
    )
    expect(response.status).toBe(502)
    expect(await response.text()).toContain('API_ORIGIN')
    // It must not have guessed a URL: `fetch('undefined/auth/google')` produces an error
    // somewhere else entirely, about a hostname nobody configured.
    expect(calls).toHaveLength(0)
  })

  it('names COUCHDB_URL when that is the missing one', async () => {
    const { impl } = recordingFetch(new Response('unreachable'))
    const response = await forward(
      { request: incoming('https://app.matter-manager.io/db/x'), env: { API_ORIGIN: 'https://a' } },
      'db',
      impl,
    )
    expect(await response.text()).toContain('COUCHDB_URL')
  })

  it('answers a plain-text 502, so the smoke test can tell a Function ran', async () => {
    // deploy.yml asserts that /api/healthz is not text/html. That assertion passes on a 502
    // deliberately - a 502 from our own Function proves a Function answered at all, which is
    // the single fact that was false before this change existed.
    const { impl } = recordingFetch(new Response('unreachable'))
    const response = await forward(
      { request: incoming('https://app.matter-manager.io/api/healthz'), env: {} },
      'api',
      impl,
    )
    expect(response.headers.get('content-type')).toMatch(/^text\/plain/)
  })

  it('answers 502 without disclosing the upstream when it cannot be reached', async () => {
    const { impl } = recordingFetch(() => {
      throw new TypeError('connection refused')
    })
    const response = await forward(
      { request: incoming('https://app.matter-manager.io/api/healthz'), env: LIVE },
      'api',
      impl,
    )
    expect(response.status).toBe(502)
    expect(await response.text()).not.toContain('api.matter-manager.io')
  })

  it('passes the upstream reply straight back', async () => {
    const { impl } = recordingFetch(new Response('{"status":"ok"}', { status: 200 }))
    const response = await forward(
      { request: incoming('https://app.matter-manager.io/api/healthz'), env: LIVE },
      'api',
      impl,
    )
    expect(response.status).toBe(200)
    expect(await response.text()).toBe('{"status":"ok"}')
  })

  it('forwards the method', async () => {
    const { impl, calls } = recordingFetch(new Response(null, { status: 200 }))
    await forward(
      { request: incoming('https://app.matter-manager.io/db/project_local/doc', {}, 'HEAD'), env: LIVE },
      'db',
      impl,
    )
    expect(calls[0]?.init.method).toBe('HEAD')
  })
})
```

Replace the import of the forwarder at the top of the file with:

```ts
import {
  forward,
  prefixFor,
  stripPrefix,
  targets,
  toResponse,
  upstreamHeaders,
  upstreamUrl,
} from '../../../functions/_lib/forward.js'
```

- [ ] **Step 2: Run it and watch it fail**

```bash
cd frontend && npx vitest run test/ui/deploy/forward.test.ts
```

Expected: FAIL — `forward is not a function`.

- [ ] **Step 3: Write the implementation**

Append to `frontend/functions/_lib/forward.ts`:

```ts
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
    { status: 502, headers: { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' } },
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
```

- [ ] **Step 4: Write the two route files**

Create `frontend/functions/api/[[path]].ts`:

```ts
import { forward, type PagesContext } from '../_lib/forward.js'

/**
 * Everything under `/api`, forwarded to the API with the prefix removed.
 *
 * `[[path]]` is Cloudflare's catch-all: it matches `/api` itself and every path beneath it.
 * A single `functions/[[path]].ts` at the root would have been fewer files and would have
 * intercepted every request on the site, including every static asset - making `_routes.json`
 * load-bearing for correctness rather than merely explicit.
 */
export const onRequest = (context: PagesContext): Promise<Response> => forward(context, 'api')
```

Create `frontend/functions/db/[[path]].ts`:

```ts
import { forward, type PagesContext } from '../_lib/forward.js'

/**
 * Everything under `/db`, forwarded to CouchDB with the prefix removed.
 *
 * `COUCHDB_URL` names the public hostname rather than a private address, and that is the
 * access control: every request therefore passes through the host Caddy on `wisselroot` and
 * inherits its `@forbidden` blocklist - `_all_dbs`, `_utils`, `_membership`,
 * `_node/_local/_config`, `_cluster_setup`. The list is defined once, in that Caddyfile, and
 * this file deliberately adds no second copy to drift out of step with it.
 *
 * Ships ahead of its consumer: `src/ui/sync/` exists and nothing in the shipped bundle imports
 * it yet. That is in the spec and is deliberate - honouring one of the two prefixes that
 * `devProxy` names would recreate the development/production split the contract exists to
 * prevent.
 */
export const onRequest = (context: PagesContext): Promise<Response> => forward(context, 'db')
```

- [ ] **Step 5: Run the tests and the typecheck**

```bash
cd frontend && npx vitest run test/ui/deploy/forward.test.ts && npm run typecheck
```

Expected: PASS, 42 tests. Typecheck clean, including both route files.

- [ ] **Step 6: Format and commit**

```bash
cd frontend && npm run check:fix
cd .. && git add frontend/functions frontend/test/ui/deploy/forward.test.ts
git commit -m "$(cat <<'EOF'
feat(functions): forward /api and /db from the application's own origin

The one function with side effects, and the two routes Cloudflare invokes. Everything it
decides was already tested by calling it; this adds fetch, and takes fetchImpl so the tests
still do not need a network.

redirect: 'manual' is pinned by a test. The default is follow, and a Function that followed
would fetch Google's authorization page server-side during sign-in and return that HTML from
our origin with a 200 - user never redirected, no cookie set, nothing reported as an error.

A missing variable is a 502 that names it, refused before any fetch, in text/plain. Naming it
matters because the alternative is fetch('undefined/auth/google') failing somewhere else about
a hostname nobody configured; text/plain matters because deploy.yml's smoke test distinguishes
"a Function answered" from "the app shell was served" by content type, and must pass on this.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 6: `_routes.json` and the checker that guards it

`_routes.json` decides which requests reach a Function at all. Wrongly narrowed, the site answers 200 with the app shell from `/api/*` — the original bug, restored, with the code present and correct.

**Files:**
- Create: `frontend/public/_routes.json`
- Create: `frontend/scripts/check-deploy-routes.mjs`
- Create: `frontend/test/ui/deploy/fixtures/routes-missing-db/_routes.json`
- Modify: `frontend/package.json` (`scripts`)
- Modify: `.github/workflows/ci.yml` (after the "Caching contract" step, ~line 150)
- Modify: `.github/workflows/deploy.yml` (after the "Caching contract" step, ~line 138)

**Interfaces:**
- Consumes: the `functions/` directory from Task 5.
- Produces: `npm run check:routes`, wired into `verify` and both workflows.

- [ ] **Step 1: Write the file being guarded**

Create `frontend/public/_routes.json`:

```json
{
  "version": 1,
  "include": ["/api/*", "/db/*"],
  "exclude": []
}
```

Vite copies `public/` into `dist/`, and wrangler reads `_routes.json` from the directory it uploads — a custom one wins over the one it would otherwise generate from the `functions/` tree (`src/api/pages/deploy.ts`). It sits beside `_headers`, which reaches the deployment the same way.

- [ ] **Step 2: Write the fixture the checker is tested against**

Create `frontend/test/ui/deploy/fixtures/routes-missing-db/_routes.json` — a file that is valid JSON, plausible, and wrong in the way that matters:

```json
{
  "version": 1,
  "include": ["/api/*"],
  "exclude": []
}
```

- [ ] **Step 3: Write the checker**

Create `frontend/scripts/check-deploy-routes.mjs`:

```js
#!/usr/bin/env node
/**
 * Guards the file that decides whether the forwarders run at all.
 *
 * `_routes.json` tells Cloudflare which paths invoke a Pages Function. Everything it does not
 * include is served from the CDN as a static asset - and a single-page application serves the
 * app shell for any path it does not recognise. So a `/api/*` missing from `include` does not
 * produce a 404. It produces **200, with `<!doctype html>`**, which is what
 * `https://matter-manager-app.pages.dev/api/healthz` answered on 2026-09-28 and the reason
 * this directory exists.
 *
 * That is the whole argument for a checker rather than a comment: every other way of noticing
 * requires somebody to look at a response body that has a 200 next to it.
 *
 * Usage:  node scripts/check-deploy-routes.mjs [--scan <directory>]
 *
 * `--scan` points at a directory containing a `_routes.json`, so the checker can be exercised
 * over fixtures. Without it, the real one under `public`. Same argument as
 * `check-deploy-headers.mjs`, deliberately - two checkers with two ways to be pointed
 * somewhere is one more thing to remember.
 */

import { existsSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')

const scanIndex = process.argv.indexOf('--scan')
const directory = scanIndex === -1 ? join(root, 'public') : process.argv[scanIndex + 1]

if (directory === undefined) {
  console.error('--scan needs a directory.')
  process.exit(1)
}

/**
 * Every prefix that must reach a Function, and the directory that serves it.
 *
 * The two halves are checked against each other: a route file with no `include` is dead code,
 * and an `include` with no route file invokes a Function that does not exist. Both are silent.
 */
const FORWARDED = [
  { prefix: '/api', route: 'functions/api/[[path]].ts', why: 'sign-in and every API call' },
  { prefix: '/db', route: 'functions/db/[[path]].ts', why: 'replication' },
]

const problems = []
const file = join(directory, '_routes.json')

if (!existsSync(file)) {
  // Not "nothing to check". Without this file wrangler generates one from the functions tree,
  // which is usually right and is not what was reviewed - and if the functions tree is also
  // missing, the deployment is static assets alone with nothing anywhere turning red.
  console.error(`No _routes.json in ${directory}. Nothing pins which paths invoke a Function.`)
  process.exit(1)
}

let routes
try {
  routes = JSON.parse(readFileSync(file, 'utf8'))
} catch (error) {
  console.error(`${file} is not valid JSON: ${error.message}`)
  process.exit(1)
}

// Cloudflare rejects anything else, and rejects it at deploy time - which is the good case.
// Checked here so the message names the file rather than arriving as an API error.
if (routes.version !== 1) {
  problems.push({
    where: '_routes.json',
    what: `version is ${JSON.stringify(routes.version)}, and Cloudflare accepts only 1`,
    detail: 'The deploy would be rejected.',
  })
}

const include = Array.isArray(routes.include) ? routes.include : []
const exclude = Array.isArray(routes.exclude) ? routes.exclude : []

if (!Array.isArray(routes.include)) {
  problems.push({
    where: '_routes.json',
    what: 'include is not an array',
    detail: 'With nothing included, no request invokes a Function and every path serves the app shell.',
  })
}

/** Whether a Cloudflare route pattern covers everything beneath a prefix. */
function covers(pattern, prefix) {
  return pattern === '/*' || pattern === `${prefix}/*` || pattern === `${prefix}*`
}

for (const { prefix, route, why } of FORWARDED) {
  if (!include.some((pattern) => covers(pattern, prefix))) {
    problems.push({
      where: prefix,
      what: 'no include pattern covers it',
      detail:
        `${why} would be served by the CDN instead of by ${route}, and the single-page ` +
        'fallback answers 200 with the app shell rather than 404. Nothing about the ' +
        'deployment looks wrong.',
    })
  }

  // Cloudflare evaluates `exclude` first, so an entry here silently wins over `include`.
  if (exclude.some((pattern) => covers(pattern, prefix))) {
    problems.push({
      where: prefix,
      what: 'an exclude pattern covers it',
      detail: `exclude is evaluated before include, so ${route} would never run.`,
    })
  }

  // Only for the real tree: a fixture directory has no functions/ beside it.
  if (scanIndex === -1 && !existsSync(join(root, route))) {
    problems.push({
      where: route,
      what: 'is included in _routes.json but does not exist',
      detail: 'The path would invoke a Function that was never written, and fall through.',
    })
  }
}

if (problems.length === 0) {
  console.log('deploy routes: ok (/api and /db reach their Functions, nothing excludes them)')
  process.exit(0)
}

console.error(`${file} would deploy an application whose forwarders never run:\n`)
for (const problem of problems) {
  console.error(`  ${problem.where}: ${problem.what}`)
  console.error(`    ${problem.detail}\n`)
}
console.error('See docs/superpowers/specs/2026-09-29-pages-functions-proxy-design.md.')
process.exit(1)
```

- [ ] **Step 4: Prove the checker fails on the fixture and passes on the real file**

```bash
cd frontend
node scripts/check-deploy-routes.mjs --scan test/ui/deploy/fixtures/routes-missing-db
echo "exit=$?"
node scripts/check-deploy-routes.mjs
echo "exit=$?"
```

Expected: the first prints `/db: no include pattern covers it` and `exit=1`; the second prints `deploy routes: ok …` and `exit=0`. A checker that passes its own negative fixture is the failure mode this step exists to catch.

- [ ] **Step 5: Wire it into the scripts**

In `frontend/package.json`, add after the `check:deploy` line:

```json
    "check:routes": "node scripts/check-deploy-routes.mjs",
```

and extend `verify`, inserting `check:routes` directly after `check:deploy`:

```json
    "verify": "npm run check:webawesome && npm run check:i18n && npm run check:deploy && npm run check:routes && npm run check:graph && npm run check && npm run typecheck && npm run test && npm run build && npm run check:lazy && npm run check:offline"
```

Task 7 adds `check:functions` immediately after `check:routes` in both places.

- [ ] **Step 6: Wire it into both workflows**

In `.github/workflows/ci.yml`, directly after the `Caching contract` step (the one running `npm run check:deploy`):

```yaml
      # The other half of the deployment contract. `_headers` decides how long the browser
      # keeps what it was given; `_routes.json` decides whether it reaches a Function at all.
      # Here as well as in deploy.yml for the same reason the step above is: a `/api/*` that
      # has fallen out of `include` ships as 200 with the app shell, which review catches and
      # monitoring does not.
      - name: Forwarder routes
        run: npm run check:routes
        working-directory: frontend
```

In `.github/workflows/deploy.yml`, directly after its own `Caching contract` step, the same block.

- [ ] **Step 7: Run the whole frontend verification**

```bash
cd frontend && npm run check:fix && npm run check && npm run typecheck && npx vitest run
```

Expected: Biome clean, typecheck clean, all tests pass.

- [ ] **Step 8: Commit**

```bash
git add frontend/public/_routes.json frontend/scripts/check-deploy-routes.mjs \
        frontend/test/ui/deploy/fixtures frontend/package.json \
        .github/workflows/ci.yml .github/workflows/deploy.yml
git commit -m "$(cat <<'EOF'
feat(deploy): pin which paths invoke a Function, and check it before deploying

_routes.json decides whether the forwarders run. Everything outside `include` is served as a
static asset, and a single-page application answers the app shell for any path it does not
recognise - so a /api/* that falls out of the list does not 404, it returns 200 with
<!doctype html>. That is exactly what the live deployment did on 2026-09-28.

The checker also compares the two halves against each other: an include with no route file
invokes a Function that does not exist, and a route file with no include is dead code. Both are
silent. It takes --scan like check-deploy-headers.mjs, and a fixture that omits /db proves it
fails when it should.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 7: Deploying from `frontend/`, and proving a Function answered

The mechanism that puts `functions/` where wrangler looks, plus the two guards that bracket the deploy.

**Files:**
- Modify: `frontend/package.json` (`devDependencies`, `scripts`)
- Modify: `frontend/package-lock.json` (regenerated)
- Modify: `dependency-policy.json` (`allowedDev`)
- Modify: `.github/workflows/deploy.yml` (the `Deploy` step, ~line 167; a new step before it and a new step after it)
- Modify: `.github/workflows/ci.yml` (one new step beside `check:routes`)

**Interfaces:**
- Consumes: everything from Tasks 5 and 6.
- Produces: `npm run check:functions`; a deploy whose working directory is `frontend`.

- [ ] **Step 1: Add wrangler as a frontend devDependency**

```bash
cd frontend && npm install --save-dev --ignore-scripts wrangler@^4
```

Not a convenience. `cloudflare/wrangler-action` runs `npm i` in its working directory when it cannot already resolve wrangler, and from Step 4 that directory is `frontend/` — whose `.npmrc` authenticates to the Web Awesome private registry from `WEBAWESOME_NPM_TOKEN`. That install would need the token *and* would run lifecycle scripts, which is the one thing every other install in this repository uses `--ignore-scripts` to prevent while the token is in the environment (#164). Declared here, `npm ci --ignore-scripts` has already installed it and the action installs nothing.

**This will not pass `npm run check:deps` on its own.** `scripts/check-dependencies.mjs:58` names `frontend` a bundled package, and for a bundled package it checks `devDependencies` against `dependency-policy.json` as well as the shipping fields — because a bundler will happily inline a devDependency that application source imports, so "it is a devDependency" is not by itself evidence it does not reach users. An unlisted one fails the check, and `check:deps` runs in the root `verify` and in CI.

So add `wrangler` to `allowedDev` in `dependency-policy.json`, after the `vite` entry whose argument it borrows:

```json
    "wrangler": "Deploys the site and bundles frontend/functions for Cloudflare Pages. A devDependency of the bundled package rather than of the root, because that is where functions/ lives and where the deploy has to run from: wrangler resolves the functions directory as a hardcoded join(cwd(), \"functions\") with no flag to move it, and an action that cannot already resolve wrangler installs one with `npm i` against this package's .npmrc - authenticating to the Web Awesome registry and running lifecycle scripts with the token in the environment, which is what --ignore-scripts exists to prevent everywhere else here. Provably absent from the built output, by the same argument vite carries above: it produces dist/, it is not part of it.",
```

Confirm before moving on:

```bash
npm run check:deps
```

Expected: `Dependency policy: ok (4 manifests, no undeclared shipping dependencies)`.

- [ ] **Step 2: Prove wrangler works under `--ignore-scripts`**

```bash
cd frontend && npx wrangler --version
```

Expected: a version number.

This is the assumption Step 1 rests on, and it is a real assumption rather than a formality. Wrangler depends on `esbuild` and `workerd`, both of which ship their binaries as platform-specific optional dependencies — and **`esbuild` is new to this tree**: Vite 8 bundles with rolldown, so nothing here currently installs esbuild at all. Wrangler is therefore the first dependency in this repository whose usefulness could plausibly depend on an install script, and every install here runs `--ignore-scripts`.

Modern esbuild resolves its binary through the optional platform package rather than through its postinstall, so this is expected to work. Expected is not verified, which is why the step exists. If it fails, **stop and report it** rather than adding wrangler to an allow-scripts list: the whole `workingDirectory` approach depends on this, and the documented fallback is a root `functions/` directory with the separate tsconfig and test runner the spec priced.

- [ ] **Step 3: Add a local bundle check**

The strongest guard available for "the functions directory was not bundled", and the only one that runs *before* a deploy. `wrangler pages functions build` compiles the tree with esbuild — no credentials, no network.

Add to `frontend/package.json` scripts, after `check:routes`:

```json
    "check:functions": "wrangler pages functions build --outdir .wrangler/check-functions",
```

and add it to `verify` directly after `check:routes`, so the full line reads:

```json
    "verify": "npm run check:webawesome && npm run check:i18n && npm run check:deploy && npm run check:routes && npm run check:functions && npm run check:graph && npm run check && npm run typecheck && npm run test && npm run build && npm run check:lazy && npm run check:offline"
```

Every other checker in this repository is in `verify`; one that only ran in CI would be a
checker developers meet for the first time as a red build.

Run it:

```bash
cd frontend && npm run check:functions
```

Expected: a build that reports the two routes. It also proves the `.js` import specifiers in the route files resolve to their `.ts` sources through esbuild, which nothing else checks — `npm run typecheck` checks the types and `vitest` never loads the route files at all.

Add the output directory to `.gitignore` at the repository root, beside the other build output:

```
.wrangler/
```

- [ ] **Step 4: Wire the bundle check into CI**

In `.github/workflows/ci.yml`, directly after the `Forwarder routes` step from Task 6:

```yaml
      # Bundles functions/ with esbuild, exactly as the deploy does, and needs no credentials
      # to do it. The only check that proves the directory *compiles and routes* before a
      # deployment rather than after: `npm run typecheck` checks the types, and the unit tests
      # never load the route files at all.
      - name: Forwarders bundle
        run: npm run check:functions
        working-directory: frontend
```

- [ ] **Step 5: Move the deploy's working directory**

In `.github/workflows/deploy.yml`, in the `Deploy` step, add `workingDirectory` to the `with:` block and change the deploy directory from `frontend/dist` to `dist`:

```yaml
        with:
          # **This is what makes the Pages Functions ship.** Wrangler resolves `functions/`
          # against its own working directory, hardcoded as `join(cwd(), "functions")` - there
          # is no flag to point it elsewhere, whatever the shape of `--functions-directory`
          # suggests. Run from the repository root it would look for `./functions`, find
          # nothing, and upload the assets alone: a deployment that succeeds, passes every
          # check, and answers 200 with the app shell from /api/*.
          #
          # `frontend/` is also where the npm steps above already run, and where wrangler is a
          # devDependency - so the action finds it installed and runs no `npm i` of its own
          # against an .npmrc that carries the Web Awesome token.
          workingDirectory: frontend
          apiToken: ${{ secrets.CLOUDFLARE_API_TOKEN }}
          accountId: ${{ secrets.CLOUDFLARE_ACCOUNT_ID || vars.CLOUDFLARE_ACCOUNT_ID }}
          gitHubToken: ${{ secrets.GITHUB_TOKEN }}
```

and, in the same step, the command — `dist` rather than `frontend/dist`, because the path is now relative to `frontend/`:

```yaml
          command: >-
            pages deploy dist
            --project-name=matter-manager-app
            --branch=${{ steps.branch.outputs.name }}
```

Leave every existing comment in that step in place; they explain `apiToken`, `accountId` and `--branch`, none of which this changes.

- [ ] **Step 6: Assert after the deploy that a Function answered**

In `.github/workflows/deploy.yml`, between the `Deploy` step and `Say where it went`:

```yaml
      # The one fact nothing else reveals: did a Function run?
      #
      # Deliberately weak about *what* it answered. Until the API is reachable from the edge
      # this request is a 502 - and a 502 from our own forwarder is proof that a Function ran,
      # so the check passes on it. What it refuses is `text/html`, because that is the failure
      # it exists to catch: with no Function bundled, /api/healthz falls through to the
      # single-page fallback and answers 200 with the app shell. A stricter assertion here
      # would couple deploying the site to the API being up, and would fail for the one reason
      # that is not this workflow's business.
      - name: A forwarder answered
        env:
          DEPLOYMENT_URL: ${{ steps.deploy.outputs.deployment-url }}
        run: |
          set -euo pipefail
          if [ -z "${DEPLOYMENT_URL}" ]; then
            echo "The deploy step reported no URL, so there is nothing to probe." >&2
            exit 1
          fi
          status=$(curl -sS -o /tmp/probe.body -w '%{http_code}' \
            -H 'Accept: */*' "${DEPLOYMENT_URL}/api/healthz")
          type=$(curl -sS -o /dev/null -w '%{content_type}' \
            -H 'Accept: */*' "${DEPLOYMENT_URL}/api/healthz")
          echo "GET ${DEPLOYMENT_URL}/api/healthz -> ${status} ${type}"
          case "${type}" in
            text/html*)
              echo >&2
              echo "/api/healthz was served the app shell, so no Pages Function ran." >&2
              echo "The functions/ directory was not bundled - check that the Deploy step" >&2
              echo "still sets workingDirectory: frontend, and see" >&2
              echo "docs/superpowers/specs/2026-09-29-pages-functions-proxy-design.md." >&2
              head -c 200 /tmp/probe.body >&2
              exit 1
              ;;
          esac
          echo "A Function answered (${status}); the forwarder is deployed."
```

- [ ] **Step 7: Run the full verification**

```bash
cd frontend && npm run verify
```

Expected: every check passes, including `check:routes`, and the build succeeds. This is the gate `ci.yml` applies, run locally before the branch goes up.

- [ ] **Step 8: Commit**

```bash
git add frontend/package.json frontend/package-lock.json dependency-policy.json .gitignore \
        .github/workflows/ci.yml .github/workflows/deploy.yml
git commit -m "$(cat <<'EOF'
build(deploy): run the deploy from frontend/, so wrangler finds functions/

Wrangler resolves the functions directory as a hardcoded join(cwd(), "functions") and offers no
flag to move it - `wrangler pages deploy` takes nine options and none of them is
--functions-directory. So the working directory moves instead: wrangler-action passes
workingDirectory as the command's cwd, and the deploy directory becomes `dist` rather than
`frontend/dist` because it is now relative to that.

That drags wrangler into frontend's devDependencies, which is the point rather than a side
effect. The action runs `npm i` in its working directory when it cannot resolve wrangler, and
an install in frontend/ authenticates to the Web Awesome registry and runs lifecycle scripts
with WEBAWESOME_NPM_TOKEN in the environment - the thing --ignore-scripts exists to prevent
everywhere else here. Declared in package.json, `npm ci --ignore-scripts` has already put it
there and the action installs nothing.

Two guards bracket the deploy. `check:functions` bundles functions/ with esbuild in CI, needing
no credentials, and is the only check that proves the tree compiles and routes *before* a
deployment. Afterwards, one request to /api/healthz that fails only on text/html: a 502 passes,
deliberately, because a 502 from our own forwarder proves a Function ran, and that is the
single fact that was false before this branch.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## After the last task

- [ ] **Push the branch and open the pull request.**

`claude/pages-functions-proxy` still carries `10b87a5` and `0b3cc88`, which are also on `claude/couchdb-config-fixes` as PR #196. Once #196 merges, rebase onto `main` — git drops both by patch-id — and re-point the droplet's `/opt/matter-manager` checkout at `main`, since `0b3cc88` is currently the only commit carrying all three changes that deployment was built from.

- [ ] **What cannot be verified until it is merged.** `deploy.yml` runs only on a push to `main` or a hand dispatch, so the `workingDirectory` change and the post-deploy probe are first exercised by the deploy that merging causes. The probe is written to fail loudly and name the cause; the local `check:functions` is what reduces the chance of needing it.

- [ ] **Remove `COUCHDB_ADMIN_USER` and `COUCHDB_ADMIN_PASSWORD` from the Pages project** (see `docs/tasks/todo-couch-image-and-api.md`). Nothing reads them, and this branch is the change that makes them live at the edge: a Pages Function runs with the project's environment bound to it. The forwarder holds no credential by design — the browser presents its own short-lived JWT — so leaving CouchDB admin credentials reachable by any code in `functions/` contradicts the design this plan implements. Not done inside the plan because it is production configuration, not code.
