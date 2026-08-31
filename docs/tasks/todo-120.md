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

- [ ] `packages/api/Dockerfile` — the file `infra/compose.prod.yml` has referenced since M0
- [ ] One command that brings up CouchDB, the API and the web application together
- [ ] Dev keys generated on first run rather than pasted from a README
- [ ] Vite proxies `/api` and `/db`
- [ ] `.env.example` says how the two are reached, and something reads it
- [ ] The stack verified running end to end, not merely started

## Review
