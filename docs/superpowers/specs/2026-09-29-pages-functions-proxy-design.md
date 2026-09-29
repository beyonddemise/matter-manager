# Forwarding `/api` and `/db` from Cloudflare Pages — design

Date: 2026-09-29
Status: proposed

## What this finishes

`frontend/vite.config.ts` has promised since M5 that `/api` and `/db` are served from the
application's own origin, with the prefix stripped before the request reaches the API or CouchDB.
In development Vite keeps that promise. In production nothing does: there is no `functions/`
directory in this repository, so both paths fall through to the single-page application's
fallback and answer **200 with the app shell**. Measured against the live deployment on
2026-09-28:

```text
GET https://matter-manager-app.pages.dev/api/healthz  ->  200  <!doctype html>
GET https://matter-manager-app.pages.dev/db/          ->  200  <!doctype html>
```

That is the failure this document exists to remove, and its shape is worth naming before the
design begins: **a missing proxy does not 404.** It returns the same 200 a working one returns,
with a body nobody inspects. Every guard below that looks paranoid is answering that one fact.

The comment in `frontend/public/_headers` describes the alternative that this design rejects —
naming the API and CouchDB origins in `connect-src` and finding a way to substitute deployment
hostnames into a static asset at build time. Proxying deletes that problem rather than solving
it: there is no third-party origin to name, `connect-src 'self'` stays true as written, and no
build-time substitution step has to exist.

## Scope

Both forwarders, in one change. `/db` ships ahead of its consumer — `src/ui/sync/` exists but
nothing in the shipped bundle imports it — and that is accepted deliberately. The contract in
`devProxy` names both prefixes; honouring one of them in production would recreate the
development/production split that the contract was written to prevent, and would mean opening
these files again the moment replication is wired.

Wiring `src/ui/sync/` is **not** in scope. This change is deployment plumbing.

## Where the code lives

`frontend/functions/`, reached by running the deploy **from `frontend/`** rather than by naming
the directory.

Wrangler resolves `functions/` relative to the working directory, and the deploy runs
`wrangler pages deploy frontend/dist` from the repository root — so the zero-configuration
location is a new top-level `functions/` folder. That is the wrong place twice over: commit
`0a3b6b7` has just finished tidying the root, and code there would sit outside every workspace,
needing its own tsconfig, its own Biome coverage and its own test runner configuration. The
repository root has no `tsconfig.json` and no test runner at all, so "needing its own" means
writing both. Inside `frontend/` all four already exist, and the tests land beside
`frontend/test/ui/deploy/`, where the existing proxy test already lives.

**Corrected 2026-09-29.** This section previously said the cost was `--functions-directory
frontend/functions`, "one flag in the deploy command". **That flag does not exist.** The
argument list of `wrangler pages deploy` is `directory`, `project-name`, `branch`,
`commit-hash`, `commit-message`, `commit-dirty`, `skip-caching`, `no-bundle` and
`upload-source-maps`, plus three hidden ones — read from `src/pages/deploy.ts` in
`cloudflare/workers-sdk`, not from the documentation, which omits the hidden ones and so cannot
be used to prove absence. `functionsDirectory` is real but belongs to the *programmatic* API
(`src/api/pages/deploy.ts`, `customFunctionsDirectory`); the CLI never supplies it and falls
back to a hardcoded `join(cwd(), "functions")`.

It is worth naming what that error would have cost, because it is this document's own opening
paragraph turned on its author: an unrecognised flag either aborts the deploy or is ignored, and
if it were ignored, wrangler would find no `functions/` at the root, upload the assets alone, and
**every guard below would pass**. `_routes.json` would still be present and still be correct.
The site would answer 200 with the app shell from `/api/*` — the exact failure this design
exists to remove, reintroduced by the mechanism chosen to remove it.

So the working directory moves instead, which is the same idea with no flag in it:
`cloudflare/wrangler-action` takes a `workingDirectory` input (its bundle passes it as
`cwd`), and `workingDirectory: frontend` with `command: pages deploy dist` makes
`join(cwd(), "functions")` resolve to `frontend/functions`.

**Wrangler becomes a `frontend` devDependency, and that is not incidental.** The action installs
wrangler with `npm i` in its working directory when it cannot already resolve one. Pointed at
`frontend/`, that install would run against `frontend/.npmrc`, which authenticates to the Web
Awesome private registry from `WEBAWESOME_NPM_TOKEN` — so the step would need the token, and
`npm i` runs lifecycle scripts, which is precisely what every other install in this repository
uses `--ignore-scripts` to prevent while that token is in the environment (#164). Declaring
wrangler in `frontend/package.json` means the existing `npm ci --ignore-scripts` has already put
it there, the action finds it and installs nothing, and the version that deploys is the one in
the lockfile rather than whatever `latest` resolved to that morning — which is the same argument
`deploy.yml` already makes for building here rather than in Cloudflare's CI.

It also buys the strongest guard available for the failure in the first row of the table below:
`wrangler pages functions build` bundles `functions/` locally, with no credentials and no
network, so CI can prove the directory compiles and routes **before** a deploy rather than
inferring it from a response afterwards.

```text
frontend/functions/
  _lib/forward.ts      pure — targets(), upstreamUrl(), upstreamHeaders(), toResponse()
  api/[[path]].ts      onRequest -> forward(context, 'api')
  db/[[path]].ts       onRequest -> forward(context, 'db')
frontend/public/_routes.json   copied to dist/, pins invocation to /api/* and /db/*
```

Two route files rather than one root catch-all, because the two forwarders genuinely differ —
`/api` forwards cookies and `/db` must not — and because a root catch-all intercepts every
request on the site, including every static asset, making `_routes.json` load-bearing for
correctness rather than merely explicit.

## Targets, and what happens when one is missing

`targets(env)` takes its environment as an argument and returns the two upstream origins, mirroring
`devProxy(env)` deliberately: same shape, same testability, and the parity test below can import
both and compare them.

| Variable | Live value | Set where |
| --- | --- | --- |
| `API_ORIGIN` | `https://api.matter-manager.io` | Pages project production — set 2026-09-29 |
| `COUCHDB_URL` | `https://couch.matter-manager.io/` | Pages project production — already set |

Both values are read back from the project rather than quoted from memory, and the second one is
why: **`COUCHDB_URL` ends in a slash.** Concatenating it with a stripped path yields
`https://couch.matter-manager.io//project_local`, and an empty first path segment is not
cosmetic to CouchDB — it is a different route. `upstreamUrl` therefore trims trailing slashes
from the origin, and a test pins it with the live value rather than a tidy one. Writing
`API_ORIGIN` without a trailing slash does not make this safe; it makes it *untested*, which is
how the pair would come apart the first time somebody pasted the other form into the dashboard.

`COUCHDB_URL` names the public hostname, never a bypass. That is what puts every `/db` request
through the host Caddy on `wisselroot` and so inherits its `@forbidden` blocklist — `_all_dbs`,
`_utils`, `_membership`, `_node/_local/_config`, `_cluster_setup`. The blocklist is defined once,
in the Caddyfile that `infra/Caddyfile` documents, and this design adds no second copy of it to
drift out of step.

A missing or empty variable returns **502 naming the variable**. It does not fetch
`undefined/auth/google`, and it does not fall through to the asset handler. L28's rule — a
variable is configured when something reads it — has a runtime counterpart: a variable nobody
supplied should fail where it is read, loudly, rather than produce a request to a nonsense URL
whose error arrives somewhere else entirely.

## The sign-in path, end to end

This is the flow the change exists to enable, and every header decision below is answerable to it.

1. The browser navigates to `/api/auth/google`.
2. The Function strips the prefix and fetches `${API_ORIGIN}/auth/google` with
   **`redirect: 'manual'`**.
3. The API answers 302 to `accounts.google.com`, setting the PKCE carrier cookie. Both the
   `Location` and the `Set-Cookie` are passed back untouched.
4. Google returns the browser to
   `https://app.matter-manager.io/api/auth/google/callback?code=...`.
5. The Function forwards it, carrying the flow cookie, to `${API_ORIGIN}/auth/google/callback`.
6. The API exchanges the code, sets the session cookie, and 302s to `${APP_ORIGIN}/`.
7. The browser lands on the application holding a first-party `HttpOnly` session cookie.

**`redirect: 'manual'` is not a detail.** The default is `follow`, and a Function that follows
step 3 would fetch Google's authorization page server-side and return *that* to the browser — a
200 containing Google's HTML, served from `app.matter-manager.io`, with the user never redirected
and no cookie anywhere. It fails as a broken page rather than as an error.

`GOOGLE_REDIRECT_URI` on the API must be the registered
`https://app.matter-manager.io/api/auth/google/callback`. The API only echoes that value to
Google; it never compares it to its own route path, so the `/api` prefix the API never sees is
not a problem.

**Why same-origin proxying is what makes the cookies work.** `auth/routes.ts:84` sets
`Path=/; HttpOnly; SameSite=Lax; Secure`. Through this proxy every one of those is first-party
and simply correct. Against a cross-origin API, `SameSite=Lax` would still permit the top-level
redirect in step 4 — so sign-in would appear to work — and would then withhold the cookie from
every subsequent `fetch`, which is the intermittent, browser-dependent failure this topology
avoids by construction rather than by configuration.

## Headers

| | `/api` | `/db` |
| --- | --- | --- |
| `Cookie` | forwarded | **stripped** |
| `Authorization` | forwarded | forwarded — PouchDB's bearer JWT |
| `X-Forwarded-For` | overwritten with `CF-Connecting-IP` | overwritten |
| `X-Forwarded-Proto` / `-Host` | set | set |
| hop-by-hop: `Connection`, `Keep-Alive`, `Transfer-Encoding`, `Upgrade`, `Proxy-*` | removed, both directions | removed |
| CORS response headers | none added | none added |

**`Cookie` is stripped on `/db` because nothing removes it otherwise.** The session cookie is
`Path=/`, so the browser attaches it to every `/db/*` request without being asked. CouchDB has no
use for it — replication authenticates with the bearer JWT — so forwarding it would ship a
thirty-day credential to a different service, and into its logs, on every replication request.

**`X-Forwarded-For` is overwritten, not appended.** The API runs with `TRUST_PROXY: 'true'`, and
Fastify then reads the *leftmost* entry as the client address. Appending would leave anything the
caller sent in that leftmost position, letting a caller choose their own rate-limit bucket;
overwriting discards it. The value is Cloudflare's `CF-Connecting-IP`, which the edge sets and a
client cannot forge. Caddy appends its own hop after ours, which is harmless — leftmost stays
ours.

Getting this wrong is not a subtle degradation. `infra/compose.prod.yml` states the consequence:
every request would count against one bucket, so "the first twenty sign-in attempts from anywhere
lock out everybody else."

**No CORS headers are added.** Every request is same-origin by construction. Emitting
`Access-Control-Allow-Origin` would describe a cross-origin flow that does not exist, and would
be the first thing to mislead somebody debugging a future one.

**Responses are rebuilt as `new Response(upstream.body, upstream)`**, which preserves repeated
headers. `clearCookies` sets two `Set-Cookie` headers in one reply; copying headers one key at a
time through a plain object would keep one of them and lose the other, leaving a cookie the user
believed they had cleared.

Bodies pass as streams in both directions. `_changes` and `_bulk_docs` are not buffered.

## Failure modes, and the guards for each

| Failure | Symptom without a guard | Guard |
| --- | --- | --- |
| Functions directory not bundled | 200, app shell, from `/api/*` | `_routes.json` shipped explicitly and asserted before deploy; post-deploy smoke assertion that `/api/healthz` is not `text/html` |
| `API_ORIGIN` unset | request to `undefined/auth/google` | 502 naming the variable |
| Upstream unreachable | Worker exception, opaque 500 | 502, short body, upstream URL not disclosed to the browser |
| Redirect followed instead of passed | Google's HTML served from our origin, no cookie | `redirect: 'manual'`, pinned by test |
| Session cookie forwarded to CouchDB | silent credential leak, no symptom at all | header stripped, pinned by test |

The first row is the one that has already happened, and the only one with no natural symptom, so
it gets two guards rather than one.

**Before the deploy**, a new `frontend/scripts/check-deploy-routes.mjs` asserts that
`public/_routes.json` exists and that its `include` covers `/api/*` and `/db/*`. It takes the same
`--scan <directory>` argument as `check-deploy-headers.mjs`, so the checker can be exercised over
fixtures rather than only over the real file, and it is wired in beside it: a `check:routes` script
in `frontend/package.json`, added to `verify` and to the two workflow steps that already run
`check:deploy` (`ci.yml:150`, `deploy.yml:138`). A separate script rather than an extension of the
headers checker, because this repository keeps one concern per checker — `check-i18n`,
`check-lazy-fallback`, `check-module-graph`, `check-offline-assets` — and because the headers
checker's name would stop describing it.

**After the deploy**, a step in `deploy.yml` requests `/api/healthz` from the action's
`deployment-url` output and fails if the response is `text/html`. Note what it deliberately does
*not* require: until `API_ORIGIN` has a value that request answers **502**, and the assertion
passes, because a 502 from our own Function is proof the Function is running. The check asks only
whether a Function answered at all — which is the single fact that was false today, and the one
nothing else reveals.

## Tests

`frontend/test/ui/deploy/forward.test.ts`, driving the pure module with injected environment and
constructed `Request` objects — the pattern `dev-proxy.test.ts` already established, and for the
same stated reason: a test that reads the machine's own `.env` passes for its author and fails for
everybody else.

Pinned behaviours: prefix stripping, including `/api/things/api-key` where the word appears twice
and only the first is the mount point; `Cookie` stripped for `db` and kept for `api`;
`Authorization` preserved on both; `X-Forwarded-For` overwritten rather than appended, including
when the caller supplies one; `redirect: 'manual'`; hop-by-hop headers removed in both directions;
repeated `Set-Cookie` surviving; 502 with the variable's name when a target is missing.

And a **parity test** importing both `devProxy` and `targets`, asserting they agree on the two
prefixes and on the stripping rule. Development and production are two implementations of one
contract, and the only thing that keeps them from drifting is an assertion that fails when they
do.

## Out of scope

Replacing the CouchDB container so JWT authentication, CORS and `require_valid_user` are in
effect, and deploying the API itself. Both are prerequisites for this proxy to carry a working
request, and both are droplet work tracked separately. This change can be written, tested, reviewed
and merged before either is done; it simply cannot be exercised end to end until `API_ORIGIN` has
a value.
