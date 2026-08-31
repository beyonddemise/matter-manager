# todo-120 — Seven web modules are written, tested, and never imported

Closes #120 in three parts. **This is part one.**

## Why three parts

#120's acceptance spans a composition root, build-time configuration, a generated `_headers`,
a test that catches an orphaned module, the API's missing Dockerfile, a runnable dev stack,
sign-in and sign-out in the interface, and replication wiring. The issue says it plainly:
*"This is not one bug."* A single change touching authentication is the shape review serves
worst, so it lands in three:

1. **This one — the ground it needs.** The API's missing `Dockerfile`, a one-command dev stack,
   the Vite proxy that makes `/api` and `/db` same-origin, and the configuration both read.
   Nothing is claimed to be wired yet.
2. **Sign-in and sign-out**, against a stubbed provider.
3. **Projects and replication**, and with them the test that fails on a module no entry point
   reaches — which can only pass once the last of the seven is reachable.

## Same-origin, so there are no origins to allow

`_headers` says two deployment origins must be added to `connect-src` when this is wired.
That was written before the topology was settled: the application keeps its Cloudflare Pages
deployment and Pages Functions proxy `/api` and `/db` to the API host, so the browser only ever
talks to its own origin. `connect-src 'self'` already covers it, and there is nothing to
generate into that file.

Development matches: Vite proxies the same two paths, so the same relative URLs work in both.
That is the point — a path that only works in one of them is a bug nobody sees until deploy.

## Google sign-in cannot be exercised here

Without `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET` and `GOOGLE_REDIRECT_URI` the API serves no
`/auth` routes at all — `composition.ts` returns no provider and `server.ts` registers nothing.
No OAuth client is available for this work, so part two wires sign-in against a stub and says so
rather than implying the real handshake has been seen to work.

Projects and replication are unaffected: their routes take a bearer token this repository's own
key signs, so the dev stack can mint one.

## Tasks

- [x] `packages/api/Dockerfile` — the file `infra/compose.prod.yml` has referenced since M0
- [x] One command that brings up CouchDB, the API and the web application together
- [x] Dev keys generated on first run rather than pasted from a README
- [x] Vite proxies `/api` and `/db`
- [x] `.env.example` says how the two are reached, and something reads it
- [x] The stack verified running end to end, not merely started

## Review

**Part one done.** `npm run verify` clean, 2112 tests pass, and the stack was run rather than
merely written.

### Verified running, not merely started

`/healthz` returning 200 is what an *unconfigured* service returns — L28 is about exactly that
test passing while the deployment served no project routes. So the checks were:

| Through | Result |
| --- | --- |
| `docker run` the image against the CouchDB container | `/healthz` 200 |
| the same container | `POST /projects` **401**, not 404 — the route is registered and wants a token |
| the same container | `/auth/google` 404 — no Google client, exactly as designed |
| `npm run dev:stack`, then the Vite origin | `/api/healthz` → `{"status":"ok"}` |
| the same | `/db/` → CouchDB's welcome document |
| the same | `/api/projects` → 401, so the proxy reaches the API and the API is configured |

The 401 is the load-bearing one. A 404 there would mean the image starts, reports itself
healthy, and serves nothing — which is the failure mode `main.ts` was written to avoid and the
one a health check cannot see.

### `devProxy` takes its environment as an argument

The first version of the test read the resolved Vite config, which calls `loadEnv` — so the
assertions depended on whichever `.env` the machine happened to have. It passed here because
`dev-stack.mjs` had just written one with the default values in it. That is a test that passes
for its author and fails for everybody else, so the proxy construction is a function taking an
env object, and the test supplies its own.

It also covers the case a deployment tool creates: `DEV_API_TARGET=` rendered empty for an unset
value must fall back rather than produce an empty target, which is how `composition.ts` treats
the API's own variables.

### Two things deliberately not done here

**No composition root yet, and no claim that anything is wired.** The seven modules are still
orphaned. Part three brings them in along with the test that fails on a module no entry point
reaches — a test that cannot pass before the last of them is reachable, so writing it now would
mean writing it skipped.

**Nothing generated into `_headers`.** The issue expected two deployment origins to be added to
`connect-src`. The topology settled since: Pages Functions serve `/api` and `/db` from the
application's own origin, so `connect-src 'self'` already covers it and there is no substitution
step to build.
